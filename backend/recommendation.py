"""Deterministic fixture recommendation service.

This module deliberately does not call McDonald's MCP or accept credentials.
It gives the local prototype a small backend contract while the read-only MCP
adapter and the G2 order gate are being verified.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping


UPDATED_AT = "2026-10-11 14:00"
SOURCE_STATUS = "demo fixture; 待 MCP 验证"

_MEALS: dict[str, dict[str, Any]] = {
    "default": {
        "name": "经典满足一人餐",
        "subtitle": "巨无霸 · 薯条 · 无糖可乐",
        "items": [
            {"type": "主食", "name": "巨无霸", "price": "¥25.00"},
            {"type": "配餐", "name": "中薯条", "price": "¥11.00"},
            {"type": "饮料", "name": "无糖可乐（中）", "price": "¥8.00"},
        ],
        "nutrition": {"energyKcal": 845, "protein": 31, "sodium": 1020},
        "total": "44.00",
        "summary": "均衡满足 · ¥44.00",
        "reason": "按默认规则组合主食、配餐和饮料；价格与营养仅用于原型演示。",
    },
    "light": {
        "name": "清爽轻盈一人餐",
        "subtitle": "板烧鸡腿堡 · 玉米杯 · 纯牛奶",
        "items": [
            {"type": "主食", "name": "板烧鸡腿堡", "price": "¥22.00"},
            {"type": "配餐", "name": "玉米杯", "price": "¥9.00"},
            {"type": "饮料", "name": "纯牛奶", "price": "¥8.00"},
        ],
        "nutrition": {"energyKcal": 610, "protein": 29, "sodium": 780},
        "total": "39.00",
        "summary": "清爽 · ¥39.00",
        "reason": "优先选择相对清爽的主食和配餐；价格与营养仅用于原型演示。",
    },
    "value": {
        "name": "刚刚好一人餐",
        "subtitle": "麦香鸡 · 小薯条 · 柠檬红茶",
        "items": [
            {"type": "主食", "name": "麦香鸡", "price": "¥15.00"},
            {"type": "配餐", "name": "小薯条", "price": "¥6.00"},
            {"type": "饮料", "name": "柠檬红茶（中）", "price": "¥4.00"},
        ],
        "nutrition": {"energyKcal": 620, "protein": 20, "sodium": 890},
        "total": "25.00",
        "summary": "预算友好 · ¥25.00",
        "reason": "保留主食、配餐和饮料的完整结构；价格与营养仅用于原型演示。",
    },
}


def _pick_key(preferences: Mapping[str, Any]) -> str:
    if preferences.get("mood") == "light":
        return "light"
    if preferences.get("budget") == "light":
        return "value"
    return "default"


def recommend(
    preferences: Mapping[str, Any] | None = None,
    *,
    location_label: str = "通用菜单快照",
) -> dict[str, Any]:
    """Return a stable, explicitly non-live recommendation response."""

    preferences = preferences or {}
    key = _pick_key(preferences)
    recommendation = deepcopy(_MEALS[key])
    alternatives = [deepcopy(_MEALS[name]) for name in ("light", "value") if name != key]

    def decorate(meal: dict[str, Any]) -> dict[str, Any]:
        meal["dataStatus"] = "非实时"
        meal["updatedAt"] = UPDATED_AT
        meal["priceSource"] = SOURCE_STATUS
        meal["nutrition"]["source"] = SOURCE_STATUS
        return meal

    decorate(recommendation)
    for alternative in alternatives:
        decorate(alternative)
    order_draft = {
        "state": "confirmation_required",
        "source": "recommendation",
        "id": "|".join(item.get("name", "") for item in recommendation.get("items", [])),
        "store": {"storeCode": "", "storeName": location_label, "address": ""},
        "items": [dict(item, quantity=1) for item in recommendation.get("items", [])],
        "total": recommendation.get("total"),
        "nutrition": dict(recommendation.get("nutrition") or {}),
        "priceSource": recommendation.get("priceSource"),
        "payment": {"state": "not_started", "merchant": "麦当劳官方", "message": "麦麦管家不收取餐费；G2 通过前不会启动付款链路。"},
        "confirmationRequired": True,
        "writeToolsEnabled": False,
    }
    return {
        "mode": "fixture",
        "location": location_label,
        "updatedAt": UPDATED_AT,
        "dataStatus": SOURCE_STATUS,
        "sources": {
            "menu": SOURCE_STATUS,
            "price": SOURCE_STATUS,
            "nutrition": SOURCE_STATUS,
        },
        "recommendation": recommendation,
        "alternatives": alternatives,
        "orderDraft": order_draft,
        "memory": {"default": False, "consentRequired": True},
        "order": {
            "state": "disabled",
            "reason": "G2 订单闭环尚未通过；不会调用 create-order 或 cancel-order。",
        },
    }
