"""Small, provider-neutral Agent Runtime for 麦麦管家.

The first milestone deliberately runs without an LLM.  It provides the same
contracts an LLM adapter will use later: structured intent parsing, bounded
state transitions, a read-only MCP Tool Broker, and a recommendation result
with provenance.  The model must never receive credentials or call MCP
directly; a future Provider Adapter will call :meth:`AgentRuntime.handle` with
the structured user turn and use these contracts for validation.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol

from .live_recommendation import LiveRecommendationError, recommend_live
from .mcp_client import McpClientError, READ_ONLY_TOOLS, ReadOnlyMcpClient
from .recommendation import recommend


class AgentState(str, Enum):
    IDLE = "idle"
    UNDERSTANDING = "understanding"
    CLARIFYING = "clarifying"
    CONTEXT_READY = "context_ready"
    PLANNING = "planning"
    QUERYING = "querying"
    CANDIDATE_READY = "candidate_ready"
    RECOMMENDATION_READY = "recommendation_ready"
    NEEDS_REBIND = "needs_rebind"
    DEGRADED = "degraded"
    CANCELLED = "cancelled"


class ToolBrokerError(RuntimeError):
    """A read-only tool request failed or violated the broker policy."""


CITY_KEYWORDS = {
    "北京": "望京",
    "上海": "五角场",
    "深圳": "科技园",
    "广州": "天河城",
}

MOOD_TERMS = (
    ("light", ("清淡", "轻盈", "轻一点", "没负担")),
    ("satisfying", ("满足", "过瘾", "吃饱", "满足感")),
    ("balanced", ("均衡", "平衡")),
)


@dataclass
class UserIntent:
    """Validated, model-independent representation of one user request."""

    raw_text: str = ""
    goal: str = "recommend"
    city: str | None = None
    keyword: str | None = None
    store_code: str | None = None
    store_name: str | None = None
    store_address: str | None = None
    be_type: int = 1
    budget_max: float | None = None
    mood: str | None = None
    exclusions: list[str] = field(default_factory=list)
    dietary: list[str] = field(default_factory=list)
    unsupported_mode: str | None = None
    missing_fields: list[str] = field(default_factory=list)

    @property
    def preferences(self) -> dict[str, Any]:
        preferences: dict[str, Any] = {}
        if self.mood:
            preferences["mood"] = self.mood
        if self.budget_max is not None:
            preferences["budgetMax"] = self.budget_max
            if self.budget_max <= 25:
                preferences["budget"] = "light"
            elif self.budget_max <= 40:
                preferences["budget"] = "standard"
        if self.exclusions:
            preferences["exclusions"] = list(self.exclusions)
        if self.dietary:
            preferences["dietary"] = list(self.dietary)
        return preferences

    def to_public_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["preferences"] = self.preferences
        # The original expression is useful for replay in a private session,
        # but should not be copied into audit logs by default.
        value.pop("raw_text", None)
        return value


def _first_city(text: str) -> str | None:
    for city in CITY_KEYWORDS:
        if city in text:
            return city
    return None


def _budget(text: str) -> float | None:
    candidates: list[float] = []
    for match in re.finditer(r"(?:预算|不超过|以内|上限|最多)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)", text):
        try:
            candidates.append(float(match.group(1)))
        except ValueError:
            continue
    return min(candidates) if candidates else None


def _exclusions(text: str) -> list[str]:
    found: list[str] = []
    for match in re.finditer(r"(?:不要|不想要|去掉|别放|不含)([^，。！？；;\n]+)", text):
        for part in re.split(r"[、,，和以及 ]+", match.group(1)):
            part = part.strip()
            if part and part not in found:
                found.append(part)
    return found[:6]


def _dietary(text: str) -> list[str]:
    found: list[str] = []
    lowered = text.lower()
    if any(term in lowered for term in ("素食", "纯素", "不吃肉", "vegan", "vegetarian")):
        found.append("素食")
    if any(term in lowered for term in ("不辣", "少辣", "无辣", "不要辣")):
        found.append("不辣")
    return found[:6]


def parse_intent(text: str, context: Mapping[str, Any] | None = None) -> UserIntent:
    """Parse a conservative Chinese intent without pretending to be an LLM.

    This parser is the safe fallback and test double for the future Provider
    Adapter.  It only fills fields with explicit evidence; ambiguous wording
    remains a missing field for the state machine to clarify.
    """

    context = context or {}
    raw_text = str(text or "").strip()
    previous = context.get("intent") if isinstance(context.get("intent"), Mapping) else {}
    city = str(context.get("city") or previous.get("city") or "").strip() or _first_city(raw_text)
    keyword = str(context.get("keyword") or previous.get("keyword") or "").strip() or (CITY_KEYWORDS.get(city) if city else None)
    store_code = str(context.get("storeCode") or previous.get("store_code") or "").strip() or None
    store_name = str(context.get("storeName") or previous.get("store_name") or "").strip() or None
    store_address = str(context.get("storeAddress") or previous.get("store_address") or "").strip() or None
    be_type = int(context.get("beType") or previous.get("be_type") or 1)
    if "得来速" in raw_text or "车道取餐" in raw_text:
        be_type = 5
    if "外送" in raw_text or "麦乐送" in raw_text:
        unsupported_mode = "delivery"
    else:
        unsupported_mode = None

    mood = str(previous.get("mood") or "").strip() or None
    for value, terms in MOOD_TERMS:
        if any(term in raw_text for term in terms):
            mood = value
            break

    budget_max = _budget(raw_text)
    if budget_max is None and previous.get("budget_max") is not None:
        try:
            budget_max = float(previous["budget_max"])
        except (TypeError, ValueError):
            budget_max = None

    exclusions = _exclusions(raw_text)
    if not exclusions and isinstance(previous.get("exclusions"), list):
        exclusions = [str(item) for item in previous["exclusions"] if str(item).strip()][:6]

    goal = "order_draft" if re.search(r"下单|点餐|帮我点|来一份", raw_text) else "recommend"
    missing: list[str] = []
    if unsupported_mode:
        missing.append("delivery_store_tool")
    if not city and not store_code:
        missing.append("city")
    if not keyword and not store_code:
        missing.append("keyword")

    dietary = _dietary(raw_text)
    if not dietary and isinstance(previous.get("dietary"), list):
        dietary = [str(item) for item in previous["dietary"] if str(item).strip()][:6]

    return UserIntent(
        raw_text=raw_text,
        goal=goal,
        city=city,
        keyword=keyword,
        store_code=store_code,
        store_name=store_name,
        store_address=store_address,
        be_type=be_type if be_type in (1, 5) else 1,
        budget_max=budget_max,
        mood=mood,
        exclusions=exclusions,
        dietary=dietary,
        unsupported_mode=unsupported_mode,
        missing_fields=missing,
    )


class IntentParser(Protocol):
    """Provider adapter contract for replacing the safe fallback parser."""

    def __call__(self, text: str, context: Mapping[str, Any] | None = None) -> UserIntent:
        ...


@dataclass
class ToolCallRecord:
    name: str
    arguments: dict[str, Any]
    status: str
    error: str | None = None

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "arguments": _redact_arguments(self.arguments),
            "status": self.status,
            **({"error": self.error} if self.error else {}),
        }


def _redact_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in arguments.items():
        lowered = str(key).lower()
        if any(secret in lowered for secret in ("token", "secret", "password", "authorization", "apikey", "api_key")):
            redacted[str(key)] = "[REDACTED]"
        elif isinstance(value, Mapping):
            redacted[str(key)] = _redact_arguments(value)
        else:
            redacted[str(key)] = value
    return redacted


class ReadOnlyToolBroker:
    """Own the MCP allowlist and call records for one Agent turn."""

    def __init__(self, *, mode: str = "fixture", client: ReadOnlyMcpClient | None = None):
        if mode not in ("fixture", "live"):
            raise ValueError("mode must be fixture or live")
        self.mode = mode
        self.client = client or ReadOnlyMcpClient()
        self.records: list[ToolCallRecord] = []

    def call(self, name: str, arguments: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if name not in READ_ONLY_TOOLS:
            raise ToolBrokerError(f"tool is not in read-only allowlist: {name}")
        payload = dict(arguments or {})
        try:
            result = self.client.call_read_only(name, payload)
        except (McpClientError, OSError, TimeoutError) as exc:
            self.records.append(ToolCallRecord(name, payload, "error", str(exc)))
            raise ToolBrokerError(str(exc)) from exc
        self.records.append(ToolCallRecord(name, payload, "ok"))
        return result

    def recommend(self, intent: UserIntent) -> dict[str, Any]:
        if self.mode == "fixture":
            result = recommend(intent.preferences, location_label=intent.store_name or f"{intent.city or '通用'} · {intent.keyword or '菜单快照'}")
            result["agent"] = {"toolCalls": [], "planner": "deterministic-fallback"}
            return result
        if not intent.store_code and (not intent.city or not intent.keyword):
            raise ToolBrokerError("city and keyword are required for live MCP mode")
        try:
            result = recommend_live(
                intent.preferences,
                city=intent.city or "",
                keyword=intent.keyword or "",
                be_type=intent.be_type,
                client=self.client,
                store_code=intent.store_code,
                store_name=intent.store_name,
                store_address=intent.store_address,
                tool_call=self.call,
            )
        except (LiveRecommendationError, McpClientError, ToolBrokerError) as exc:
            if isinstance(exc, ToolBrokerError):
                raise
            raise ToolBrokerError(str(exc)) from exc
        result["agent"] = {"toolCalls": [record.to_public_dict() for record in self.records], "planner": "read-only-mcp"}
        return result


@dataclass
class AgentTurn:
    turn_id: str
    state: AgentState = AgentState.IDLE
    state_history: list[str] = field(default_factory=lambda: [AgentState.IDLE.value])
    intent: UserIntent | None = None
    response: dict[str, Any] = field(default_factory=dict)
    tool_calls: list[ToolCallRecord] = field(default_factory=list)

    def transition(self, state: AgentState) -> None:
        self.state = state
        self.state_history.append(state.value)

    def to_dict(self) -> dict[str, Any]:
        return {
            "turnId": self.turn_id,
            "state": self.state.value,
            "stateHistory": list(self.state_history),
            "intent": self.intent.to_public_dict() if self.intent else None,
            "response": self.response,
            "toolCalls": [record.to_public_dict() for record in self.tool_calls],
        }


class AgentRuntime:
    """Bounded one-turn runtime for read-only recommendation."""

    def __init__(self, broker: ReadOnlyToolBroker, *, max_steps: int = 8, intent_parser: IntentParser | None = None, provider: Any | None = None):
        self.broker = broker
        self.max_steps = max_steps
        if provider is None and intent_parser is None:
            # Lazy import avoids a module cycle: the provider contract refers
            # back to UserIntent, while the runtime owns the orchestration.
            from .provider_adapter import DeterministicProvider

            provider = DeterministicProvider()
        self.provider = provider
        self.intent_parser = intent_parser or provider.parse_intent

    def _transition(self, turn: AgentTurn, state: AgentState) -> None:
        if len(turn.state_history) >= self.max_steps:
            raise ToolBrokerError("agent step limit exceeded")
        turn.transition(state)

    def handle(self, text: str, *, context: Mapping[str, Any] | None = None) -> dict[str, Any]:
        turn = AgentTurn(turn_id=uuid.uuid4().hex)
        self._transition(turn, AgentState.UNDERSTANDING)
        provider_error: str | None = None
        try:
            intent = self.intent_parser(text, context)
        except Exception as exc:
            # A provider outage must not bypass the safe deterministic parser.
            from .provider_adapter import DeterministicProvider

            fallback_provider = DeterministicProvider()
            intent = fallback_provider.parse_intent(text, context)
            provider_error = str(exc)
        turn.intent = intent

        if intent.unsupported_mode:
            self._transition(turn, AgentState.CLARIFYING)
            turn.response = {
                "mode": "clarifying",
                "question": "当前只读推荐先支持到店自取或得来速；你要先选择一家到店门店吗？",
                "reason": "麦乐送门店查询工具尚未纳入本轮只读 Broker。",
                "memory": {"consentRequired": True, "written": False},
            }
            return turn.to_dict()

        if self.broker.mode == "live" and intent.missing_fields:
            self._transition(turn, AgentState.CLARIFYING)
            question = "请先告诉我城市和附近位置关键词。"
            if "keyword" not in intent.missing_fields and "city" in intent.missing_fields:
                question = "请先告诉我所在城市。"
            elif "city" not in intent.missing_fields and "keyword" in intent.missing_fields:
                question = "请再告诉我附近的商圈或位置关键词。"
            turn.response = {
                "mode": "clarifying",
                "question": question,
                "missingFields": list(intent.missing_fields),
                "memory": {"consentRequired": True, "written": False},
            }
            return turn.to_dict()

        self._transition(turn, AgentState.CONTEXT_READY)
        self._transition(turn, AgentState.PLANNING)
        self._transition(turn, AgentState.QUERYING)
        try:
            result = self.broker.recommend(intent)
        except ToolBrokerError as exc:
            if str(exc).startswith("preference_conflict:"):
                self._transition(turn, AgentState.CLARIFYING)
                reason = str(exc).split(":", 1)[1].strip()
                turn.response = {
                    "mode": "constraint_conflict",
                    "question": "当前门店没有同时满足这些条件的完整一人餐。要放宽哪一项？",
                    "reason": reason,
                    "preferences": intent.preferences,
                    "memory": {"consentRequired": True, "written": False},
                }
                turn.tool_calls = list(self.broker.records)
                return turn.to_dict()
            self._transition(turn, AgentState.DEGRADED)
            fallback = recommend(intent.preferences, location_label=intent.store_name or "通用菜单快照")
            fallback["agent"] = {"toolCalls": [record.to_public_dict() for record in self.broker.records], "planner": "fixture-fallback"}
            fallback["agentError"] = str(exc)
            turn.response = fallback
            turn.tool_calls = list(self.broker.records)
            return turn.to_dict()

        self._transition(turn, AgentState.CANDIDATE_READY)
        self._transition(turn, AgentState.RECOMMENDATION_READY)
        result["agentTurn"] = {
            "goal": intent.goal,
            "nextAction": "show_recommendation",
            "writeToolsEnabled": False,
            "provider": getattr(self.provider, "name", "custom"),
        }
        if self.provider is not None and hasattr(self.provider, "explain"):
            try:
                result.setdefault("agent", {})["explanation"] = self.provider.explain(result, intent)
            except Exception as exc:
                from .provider_adapter import DeterministicProvider

                result.setdefault("agent", {})["explanation"] = DeterministicProvider().explain(result, intent)
                provider_error = provider_error or str(exc)
        if provider_error:
            result["providerError"] = provider_error
        result["memory"] = {"consentRequired": True, "written": False}
        turn.response = result
        turn.tool_calls = list(self.broker.records)
        return turn.to_dict()
