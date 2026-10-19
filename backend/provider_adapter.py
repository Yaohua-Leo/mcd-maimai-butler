"""Provider Adapter contracts for 麦麦管家 Agent Runtime.

The adapter is intentionally model-agnostic.  The deterministic provider is
the safe default until a CloudBase or user-owned provider passes its own
credential, model, quota, and data-routing checks.  A future model adapter
must return the same structured ``UserIntent`` and must never receive MCP
credentials or call tools directly.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .agent_runtime import UserIntent, parse_intent


class ProviderUnavailableError(RuntimeError):
    """The selected model provider is not configured or is temporarily down."""


class AgentProvider(Protocol):
    """Minimal provider contract used by AgentRuntime."""

    name: str

    def parse_intent(self, text: str, context: Mapping[str, Any] | None = None) -> UserIntent:
        ...

    def explain(self, recommendation: Mapping[str, Any], intent: UserIntent) -> str:
        ...


class DeterministicProvider:
    """Provider-free fallback for development and no-key deployments."""

    name = "deterministic-fallback"

    def parse_intent(self, text: str, context: Mapping[str, Any] | None = None) -> UserIntent:
        return parse_intent(text, context)

    def explain(self, recommendation: Mapping[str, Any], intent: UserIntent) -> str:
        status = str(recommendation.get("dataStatus") or "非实时")
        meal = recommendation.get("recommendation") or {}
        name = str(meal.get("name") or "这份一人餐") if isinstance(meal, Mapping) else "这份一人餐"
        if intent.mood == "light":
            return f"按清淡偏好，从{status}菜单中优先选择了{name}。"
        if intent.budget_max is not None:
            return f"按预算不超过 {intent.budget_max:g} 元，从{status}菜单中生成了{name}。"
        return f"根据当前偏好，从{status}菜单中生成了{name}。"


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    api_key_env: str
    default_base_url: str
    model_env: str
    default_model: str


PROVIDER_SPECS = {
    "openai": ProviderSpec("openai", "OPENAI_API_KEY", "https://api.openai.com/v1", "OPENAI_MODEL", "gpt-4o-mini"),
    "deepseek": ProviderSpec("deepseek", "DEEPSEEK_API_KEY", "https://api.deepseek.com/v1", "DEEPSEEK_MODEL", "deepseek-chat"),
    "siliconflow": ProviderSpec("siliconflow", "SILICONFLOW_API_KEY", "https://api.siliconflow.cn/v1", "SILICONFLOW_MODEL", "deepseek-ai/DeepSeek-V3"),
    "aihubmix": ProviderSpec("aihubmix", "AIHUBMIX_API_KEY", "https://aihubmix.com/v1", "AIHUBMIX_MODEL", "gpt-4o-mini"),
    "openrouter": ProviderSpec("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "OPENROUTER_MODEL", "openai/gpt-4o-mini"),
}


def _json_object(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            value = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None


class OpenAICompatibleProvider:
    """User-owned API-key adapter for OpenAI-compatible chat endpoints."""

    def __init__(self, spec: ProviderSpec, *, timeout: int = 45):
        self.spec = spec
        self.name = spec.name
        self.api_key = os.environ.get(spec.api_key_env, "")
        if not self.api_key:
            raise ProviderUnavailableError(f"{spec.api_key_env} is not configured")
        base_url_env = f"{spec.name.upper()}_BASE_URL"
        self.base_url = os.environ.get(base_url_env, spec.default_base_url).rstrip("/")
        self.model = os.environ.get(spec.model_env, spec.default_model)
        self.timeout = timeout

    def _chat(self, messages: list[dict[str, str]], *, temperature: float = 0.1) -> str:
        body = json.dumps({"model": self.model, "messages": messages, "temperature": temperature}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            raise ProviderUnavailableError(f"{self.name} HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ProviderUnavailableError(f"{self.name} request failed") from exc
        try:
            return str(payload["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderUnavailableError(f"{self.name} returned an invalid response") from exc

    def parse_intent(self, text: str, context: Mapping[str, Any] | None = None) -> UserIntent:
        baseline = parse_intent(text, context)
        prompt = {
            "task": "Extract a McDonald's meal intent. Return JSON only.",
            "allowed": {"city": "string|null", "keyword": "string|null", "beType": "1|5", "budgetMax": "number|null", "mood": "light|satisfying|balanced|null", "exclusions": "string[]", "dietary": "string[]", "goal": "recommend|order_draft"},
            "text": text,
            "context": dict(context or {}),
        }
        content = self._chat([
            {"role": "system", "content": "You are a strict intent parser. Output one JSON object and no markdown."},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ])
        value = _json_object(content)
        if value is None:
            raise ProviderUnavailableError(f"{self.name} returned non-JSON intent")
        city = value.get("city") if isinstance(value.get("city"), str) else baseline.city
        keyword = value.get("keyword") if isinstance(value.get("keyword"), str) else baseline.keyword
        budget = value.get("budgetMax")
        try:
            budget = float(budget) if budget is not None else baseline.budget_max
        except (TypeError, ValueError):
            budget = baseline.budget_max
        mood = value.get("mood") if value.get("mood") in {"light", "satisfying", "balanced"} else baseline.mood
        exclusions = value.get("exclusions") if isinstance(value.get("exclusions"), list) else baseline.exclusions
        dietary = value.get("dietary") if isinstance(value.get("dietary"), list) else baseline.dietary
        goal = value.get("goal") if value.get("goal") in {"recommend", "order_draft"} else baseline.goal
        return UserIntent(
            raw_text=baseline.raw_text,
            goal=goal,
            city=city or baseline.city,
            keyword=keyword or baseline.keyword,
            store_code=baseline.store_code,
            store_name=baseline.store_name,
            store_address=baseline.store_address,
            be_type=5 if value.get("beType") == 5 else baseline.be_type,
            budget_max=budget,
            mood=mood,
            exclusions=[str(item) for item in exclusions if str(item).strip()][:6],
            dietary=[str(item) for item in dietary if str(item).strip()][:6],
            unsupported_mode=baseline.unsupported_mode,
            missing_fields=baseline.missing_fields,
        )

    def explain(self, recommendation: Mapping[str, Any], intent: UserIntent) -> str:
        meal = recommendation.get("recommendation") or {}
        prompt = {"intent": intent.to_public_dict(), "recommendation": meal, "instruction": "用简短中文解释推荐理由，不新增价格、营养或门店事实。"}
        return self._chat([
            {"role": "system", "content": "You explain a meal recommendation conservatively. Do not invent facts."},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ], temperature=0.2).strip()


def available_user_providers() -> list[str]:
    return [name for name, spec in PROVIDER_SPECS.items() if os.environ.get(spec.api_key_env)]


def create_provider(name: str | None = None) -> AgentProvider:
    selected = (name or os.environ.get("AGENT_PROVIDER") or "deterministic").lower()
    if selected in {"deterministic", "fixture", "none"}:
        return DeterministicProvider()
    spec = PROVIDER_SPECS.get(selected)
    if not spec:
        raise ProviderUnavailableError(f"unknown provider: {selected}")
    return OpenAICompatibleProvider(spec)
