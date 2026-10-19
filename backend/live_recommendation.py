"""Optional read-only MCP recommendation adapter.

This module is deliberately opt-in.  The local fixture remains the default
for the mini program; callers must explicitly enable the live server route
and provide ``MCD_MCP_TOKEN`` in the backend process environment.
"""

from __future__ import annotations

import json
import csv
import io
import re
import math
from typing import Any, Callable, Mapping

from .mcp_client import McpClientError, ReadOnlyMcpClient


class LiveRecommendationError(RuntimeError):
    """Raised when a read-only MCP response cannot support a recommendation."""


def _json_from_text(value: str) -> dict[str, Any] | None:
    value = value.strip()
    if not value:
        return None
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        # Some MCP clients wrap JSON in a prose response.  Only accept a
        # complete JSON object found on a single line; never guess fields.
        for line in value.splitlines():
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError:
                    continue
                break
        else:
            return None
    return decoded if isinstance(decoded, dict) else None


def _payload(response: Mapping[str, Any]) -> dict[str, Any]:
    """Unwrap common MCP JSON-RPC and content-text response shapes."""

    result = response.get("result", response)
    if not isinstance(result, dict):
        raise LiveRecommendationError("MCP response has no object result")
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                decoded = _json_from_text(item["text"])
                if decoded is not None:
                    return decoded
    if "code" in result or "data" in result:
        return result
    raise LiveRecommendationError("MCP response did not contain structured data")


def _require_success(value: dict[str, Any], tool_name: str) -> dict[str, Any]:
    code = value.get("code")
    if code not in (None, 0, 200):
        raise LiveRecommendationError(f"{tool_name} returned code {code}")
    return value


def _store_list(value: dict[str, Any]) -> list[dict[str, Any]]:
    data = value.get("data")
    if not isinstance(data, list):
        raise LiveRecommendationError("query-nearby-stores returned no store list")
    return [item for item in data if isinstance(item, dict)]


def _meal_list(value: dict[str, Any]) -> list[dict[str, Any]]:
    data = value.get("data")
    if not isinstance(data, dict):
        raise LiveRecommendationError("query-meals returned no menu data")
    meals = data.get("meals")
    if isinstance(meals, dict):
        output: list[dict[str, Any]] = []
        for code, meal in meals.items():
            if isinstance(meal, dict):
                entry = dict(meal)
                entry.setdefault("code", code)
                output.append(entry)
        return output
    if isinstance(meals, list):
        return [meal for meal in meals if isinstance(meal, dict)]
    raise LiveRecommendationError("query-meals returned no meal map")


def _price_number(meal: Mapping[str, Any]) -> float | None:
    try:
        value = meal.get("currentPrice", meal.get("price"))
        if value is None or isinstance(value, bool) or str(value).strip() == "":
            return None
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None
    except (TypeError, ValueError):
        return None


def _preference_terms(value: Any) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = []
    return [str(item).strip().lower() for item in values if str(item).strip()]


def _meal_name(meal: Mapping[str, Any]) -> str:
    return str(meal.get("name") or "").strip()


_MEAT_TERMS = ("鸡", "牛", "猪", "肉", "培根", "鱼", "虾", "火腿", "腊肉")
_SPICY_TERMS = ("辣", "麻辣", "香辣", "藤椒", "黑椒")


def _meal_allowed(meal: Mapping[str, Any], preferences: Mapping[str, Any]) -> bool:
    name = _meal_name(meal).lower()
    exclusions = _preference_terms(preferences.get("exclusions"))
    if any(term in name for term in exclusions):
        return False
    dietary = _preference_terms(preferences.get("dietary"))
    vegetarian = any(term in ("素食", "纯素", "vegan", "vegetarian", "不吃肉") for term in dietary)
    if vegetarian and any(term in name for term in _MEAT_TERMS):
        return False
    no_spicy = any(term in ("不辣", "少辣", "无辣", "清淡", "no spicy") for term in dietary)
    if no_spicy and any(term in name for term in _SPICY_TERMS):
        return False
    return True


def _check_preferences(preferences: Mapping[str, Any]) -> float | None:
    # Menu names cannot establish ingredient absence or vegetarian status.
    supported = {"不辣", "少辣", "无辣", "不要辣", "清淡", "no spicy"}
    if any(term not in supported for term in _preference_terms(preferences.get("dietary"))):
        raise LiveRecommendationError("preference_conflict: 当前菜单缺少可核实的成分资料，无法确认这项饮食限制")
    if preferences.get("mode") == "delivery":
        raise LiveRecommendationError("preference_conflict: 当前只支持到店用餐或自取，请调整就餐方式")
    budget = preferences.get("budgetMax")
    if budget is None:
        budget = {"light": 25, "standard": 40}.get(preferences.get("budget"))
    if budget is not None and _price_number({"price": budget}) is None:
        raise LiveRecommendationError("preference_conflict: 请输入有效的预算金额")
    return _price_number({"price": budget})


def _constraint_requested(preferences: Mapping[str, Any]) -> bool:
    return bool(
        preferences.get("budgetMax") is not None
        or _preference_terms(preferences.get("exclusions"))
        or _preference_terms(preferences.get("dietary"))
        or preferences.get("mood") in ("light", "satisfying", "balanced")
    )


def _mood_score(combo: tuple[dict[str, Any], dict[str, Any], dict[str, Any], float], preferences: Mapping[str, Any]) -> int:
    mood = preferences.get("mood")
    if mood not in ("light", "satisfying"):
        return 0
    names = " ".join(_meal_name(item) for item in combo[:3])
    if mood == "light":
        positive = ("玉米", "沙拉", "水果", "牛奶", "纯净水", "红茶", "板烧")
        negative = ("双层", "巨无霸", "芝士", "培根", "辣")
    else:
        positive = ("巨无霸", "双层", "牛堡", "鸡腿堡", "麦乐鸡")
        negative = ("沙拉", "玉米", "纯净水")
    return sum(names.count(term) for term in positive) * 2 - sum(names.count(term) for term in negative)


def _meal_categories(meals: list[dict[str, Any]], preferences: Mapping[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    preferences = preferences or {}
    drinks, sides, mains = [], [], []
    for meal in meals:
        if not _meal_allowed(meal, preferences):
            continue
        name = _meal_name(meal)
        if any(term in name for term in ("套餐", "组合", "件套", "人餐", "分享", "全家", "派", "冰淇淋", "新地", "麦旋风")):
            continue
        if any(term in name for term in ("可乐", "饮料", "牛奶", "咖啡", "红茶", "果汁", "雪碧", "纯净水", "矿泉水", "拿铁", "美式")):
            drinks.append(meal)
        elif any(term in name for term in ("薯条", "玉米", "小食", "鸡翅", "鸡块", "麦乐鸡")):
            sides.append(meal)
        elif any(term in name for term in ("堡", "巨无霸", "麦香鸡", "麦香鱼", "卷", "帕尼尼", "麦满分")):
            mains.append(meal)
    return mains, sides, drinks


def _meal_combinations(meals: list[dict[str, Any]], preferences: Mapping[str, Any] | None = None) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], float]]:
    preferences = preferences or {}
    mains, sides, drinks = _meal_categories(meals, preferences)
    if not mains or not sides or not drinks:
        return []
    combinations = []
    for main in mains:
        for side in sides:
            for drink in drinks:
                prices = [_price_number(main), _price_number(side), _price_number(drink)]
                if all(price is not None for price in prices):
                    combinations.append((main, side, drink, round(sum(prices), 2)))
    if preferences.get("mood") in ("light", "satisfying"):
        combinations.sort(key=lambda combo: (-_mood_score(combo, preferences), combo[3]))
    return combinations


def _select_items(meals: list[dict[str, Any]], preferences: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Pick exactly one main, side, and drink, respecting a budget when given."""

    preferences = preferences or {}
    combinations = _meal_combinations(meals, preferences)
    budget = _check_preferences(preferences)
    if combinations:
        if budget is None:
            return list(combinations[0][:3])
        eligible = [combo for combo in combinations if combo[3] <= budget]
        if not eligible:
            raise LiveRecommendationError(f"preference_conflict: 没有不超过 ¥{budget:.2f} 的完整三件套")
        selected = min(eligible, key=lambda combo: (-_mood_score(combo, preferences), abs(budget - combo[3]), combo[3]))
        return list(selected[:3])

    raise LiveRecommendationError("preference_conflict: 当前门店没有可确认的主食、配餐、饮料完整三件套")


def _alternative_combinations(
    meals: list[dict[str, Any]],
    selected: list[dict[str, Any]],
    preferences: Mapping[str, Any] | None = None,
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], float]]:
    """Return two complete, budget-aware bundles distinct from the main one."""

    preferences = preferences or {}
    combinations = _meal_combinations(meals, preferences)
    selected_codes = {str(item.get("code") or item.get("name")) for item in selected}
    alternatives = [
        combo for combo in combinations
        if {str(item.get("code") or item.get("name")) for item in combo[:3]} != selected_codes
    ]
    budget = _check_preferences(preferences)
    if budget is not None:
        alternatives = [combo for combo in alternatives if combo[3] <= budget]
    alternatives.sort(key=lambda combo: (-_mood_score(combo, preferences), combo[3]))
    if alternatives:
        return alternatives[:2]
    return []


def _price(meal: Mapping[str, Any]) -> str:
    value = meal.get("currentPrice", meal.get("price"))
    if value is None:
        return "暂无价格"
    return f"¥{value}"


def _nutrition_for(names: list[str], value: dict[str, Any]) -> dict[str, Any]:
    """Parse only explicit nutrition fields; unknown formats remain unknown."""

    raw = value.get("data")
    if not isinstance(raw, str):
        return {"source": "麦当劳 MCP；未匹配到结构化营养字段"}
    result: dict[str, Any] = {"source": "麦当劳 MCP；字段按餐品名称匹配"}
    # The current MCP response is a compact CSV-like block whose header is
    # ``{productName,...,energyKcal,...}``, not JSON.  Parse only rows whose
    # product name exactly matches a selected item.
    header_match = re.search(r"\{([^}]+)\}", raw)
    headers = [part.strip() for part in header_match.group(1).split(",")] if header_match else []
    rows: dict[str, dict[str, str]] = {}
    for line in raw.splitlines():
        if "," not in line or line.lstrip().startswith("["):
            continue
        try:
            fields = next(csv.reader(io.StringIO(line.strip())))
        except (csv.Error, StopIteration):
            continue
        if headers and len(fields) >= len(headers):
            rows[fields[0].strip()] = dict(zip(headers, fields))
    result["matchedItems"] = sum(name in rows for name in names)
    result["itemCount"] = len(names)
    result["source"] = "麦当劳 MCP；按名称匹配，缺失项不计作 0"
    for field in ("energyKcal", "protein", "sodium"):
        values = []
        for name in names:
            value = _price_number({"price": rows.get(name, {}).get(field)})
            if value is not None:
                values.append(value)
        result[field] = round(sum(values), 2) if len(values) == len(names) else "暂无"

    return result


def _meal_total(items: list[dict[str, Any]]) -> float | None:
    values = [item.get("currentPrice", item.get("price")) for item in items]
    try:
        if any(value is None for value in values):
            return None
        return sum(float(value) for value in values)
    except (TypeError, ValueError):
        return None


def _bundle(main: dict[str, Any], side: dict[str, Any], drink: dict[str, Any], nutrition: dict[str, Any]) -> dict[str, Any]:
    items = [main, side, drink]
    names = [str(item.get("name") or "未知餐品") for item in items]
    total = _meal_total(items)
    bundle_nutrition = _nutrition_for(names, nutrition)
    for field in ("energyKcal", "protein", "sodium"):
        bundle_nutrition.setdefault(field, "暂无")
    return {
        "id": "|".join(str(item.get("code") or item.get("name")) for item in items),
        "name": f"{names[0]}一人餐",
        "subtitle": " · ".join(names),
        "items": [
            {"type": label, "code": str(item.get("code") or ""), "name": str(item.get("name") or "未知餐品"), "price": _price(item), "quantity": 1}
            for label, item in zip(("主食", "配餐", "饮料"), items)
        ],
        "nutrition": bundle_nutrition,
        "total": f"{total:.2f}" if total is not None else "暂无",
        "summary": f"实时菜单 · {f'¥{total:.2f}' if total is not None else '价格待确认'}",
        "reason": f"以{names[0]}作为主食，搭配{names[1]}和{names[2]}，组成完整一人餐；以本次门店菜单价格汇总。",
        "dataStatus": "实时 MCP",
        "updatedAt": "本次查询",
        "priceSource": "麦当劳 MCP query-meals",
    }


def _order_draft(meal: dict[str, Any], store: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "state": "confirmation_required",
        "source": "recommendation",
        "id": str(meal.get("id") or meal.get("name") or ""),
        "store": {
            "storeCode": str(store.get("storeCode") or ""),
            "storeName": str(store.get("storeName") or ""),
            "address": str(store.get("address") or ""),
        },
        "items": [dict(item) for item in meal.get("items", []) if isinstance(item, dict)],
        "total": meal.get("total"),
        "nutrition": dict(meal.get("nutrition") or {}),
        "priceSource": meal.get("priceSource"),
        "payment": {"state": "not_started", "merchant": "麦当劳官方", "message": "麦麦管家不收取餐费；G2 通过前不会启动付款链路。"},
        "confirmationRequired": True,
        "writeToolsEnabled": False,
    }


def recommend_live(
    preferences: Mapping[str, Any] | None = None,
    *,
    city: str,
    keyword: str,
    be_type: int = 1,
    client: ReadOnlyMcpClient | None = None,
    store_code: str | None = None,
    store_name: str | None = None,
    store_address: str | None = None,
    be_code: str | None = None,
    tool_call: Callable[[str, dict[str, Any]], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run the read-only store/menu/detail/nutrition recommendation flow.

    ``tool_call`` lets an Agent Tool Broker own the allowlist and audit record
    while keeping this adapter usable directly by the existing local route.
    """

    client = client or ReadOnlyMcpClient()
    call_tool = tool_call or client.call_read_only
    preferences = preferences or {}
    order_type = 1 if be_type in (1, 5) else 2
    try:
        if store_code:
            store = {
                "storeCode": store_code,
                "storeName": store_name or "已选门店",
                "address": store_address or "",
                "beCode": be_code or "",
                "businessStatus": True,
            }
        else:
            stores = _store_list(
                _require_success(
                    _payload(
                        call_tool(
                            "query-nearby-stores",
                            {"searchType": 2, "city": city, "keyword": keyword, "beType": be_type},
                        )
                    ),
                    "query-nearby-stores",
                )
            )
            usable = [store for store in stores if store.get("businessStatus") is not False]
            store = usable[0] if usable else stores[0]
        store_code = str(store.get("storeCode") or "")
        if not store_code:
            raise LiveRecommendationError("selected store has no storeCode")
        args: dict[str, Any] = {"storeCode": store_code, "orderType": order_type, "beType": be_type}
        if be_type != 1:
            args["beCode"] = store.get("beCode")
        meals = _meal_list(
            _require_success(_payload(call_tool("query-meals", args)), "query-meals")
        )
        selected = _select_items(meals, preferences)
        # Detail is a read-only consistency check.  A malformed detail response
        # is a hard failure rather than silently presenting guessed composition.
        detail_args = {"storeCode": store_code, "orderType": order_type, "beType": be_type, "code": str(selected[0].get("code", ""))}
        if be_type != 1:
            detail_args["beCode"] = store.get("beCode")
        _require_success(_payload(call_tool("query-meal-detail", detail_args)), "query-meal-detail")
        nutrition = _require_success(
            _payload(call_tool("list-nutrition-foods", {})), "list-nutrition-foods"
        )
    except (McpClientError, LiveRecommendationError, KeyError, TypeError, ValueError) as exc:
        raise LiveRecommendationError(str(exc)) from exc

    meal = _bundle(*selected, nutrition)
    alternatives = [_bundle(*combo[:3], nutrition) for combo in _alternative_combinations(meals, selected, preferences)]
    return {
        "mode": "live_mcp",
        "location": str(store.get("storeName") or city),
        "updatedAt": "本次查询",
        "dataStatus": "实时 MCP",
        "sources": {"menu": "麦当劳 MCP query-meals", "price": "麦当劳 MCP query-meals", "nutrition": "麦当劳 MCP list-nutrition-foods"},
        "recommendation": meal,
        "alternatives": alternatives,
        "orderDraft": _order_draft(meal, store),
        "memory": {"default": False, "consentRequired": True},
        "order": {"state": "disabled", "reason": "推荐版只读；不会调用 create-order 或 cancel-order。"},
        "store": {
            "storeCode": store_code,
            "storeName": str(store.get("storeName") or city),
            "address": str(store.get("address") or ""),
            "businessStatus": store.get("businessStatus"),
            "beType": be_type,
        },
        "preferences": dict(preferences),
    }
