import unittest

from backend.mcp_client import McpClientError, ReadOnlyMcpClient
from backend.live_recommendation import LiveRecommendationError, _alternative_combinations, _select_items, recommend_live
from backend.token_manager import EncryptedTokenVault, TokenLifecycleError, TokenManager
from backend.recommendation import recommend


class RecommendationContractTests(unittest.TestCase):
    def test_default_response_is_fixture_and_order_locked(self) -> None:
        result = recommend({})
        self.assertEqual(result["mode"], "fixture")
        self.assertEqual(result["order"]["state"], "disabled")
        self.assertEqual(len(result["recommendation"]["items"]), 3)
        self.assertEqual(len(result["alternatives"]), 2)
        self.assertEqual(result["recommendation"]["dataStatus"], "非实时")
        self.assertIn("待 MCP 验证", result["recommendation"]["nutrition"]["source"])
        self.assertTrue(result["memory"]["consentRequired"])

    def test_light_preference_selects_light_meal(self) -> None:
        result = recommend({"mood": "light"}, location_label="上海 · 演示门店")
        self.assertEqual(result["location"], "上海 · 演示门店")
        self.assertEqual(result["recommendation"]["name"], "清爽轻盈一人餐")
        self.assertIn("待 MCP 验证", result["sources"]["nutrition"])

    def test_mcp_client_rejects_write_tools_before_network(self) -> None:
        client = ReadOnlyMcpClient(token="test-only")
        with self.assertRaises(McpClientError):
            client.call_read_only("create-order", {})

    def test_mcp_client_rejects_planned_tools_before_network(self) -> None:
        client = ReadOnlyMcpClient(token="test-only")
        for tool_name in ("calculate-price", "query-order", "order-list"):
            with self.subTest(tool_name=tool_name):
                with self.assertRaises(McpClientError):
                    client.call_read_only(tool_name, {})

    def test_value_fixture_matches_mini_program_contract(self) -> None:
        result = recommend({"budget": "light"})
        meal = result["recommendation"]
        self.assertEqual(meal["total"], "25.00")
        self.assertEqual([item["price"] for item in meal["items"]], ["¥15.00", "¥6.00", "¥4.00"])

    def test_live_read_only_flow_uses_store_menu_detail_and_nutrition(self) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.calls = []

            def call_read_only(self, name, arguments):
                self.calls.append((name, arguments))
                values = {
                    "query-nearby-stores": {"code": 200, "data": [{"storeCode": "S1", "storeName": "演示门店", "businessStatus": True}]},
                    "query-meals": {"code": 200, "data": {"meals": {
                        "M1": {"name": "巨无霸", "currentPrice": "26.5"},
                        "M2": {"name": "中薯条", "currentPrice": "11"},
                        "M3": {"name": "无糖可乐（中）", "currentPrice": "8"},
                        "M4": {"name": "培根蔬萃双层牛堡", "currentPrice": "25"},
                        "M5": {"name": "双层吉士汉堡", "currentPrice": "23"},
                    }}},
                    "query-meal-detail": {"code": 200, "data": {"name": "巨无霸", "supportModify": False}},
                    "list-nutrition-foods": {"code": 200, "data": "[3]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  巨无霸,null,2100,513,27,30,40,961,200\n  中薯条,null,1210,289,4,12,38,165,18\n  无糖可乐（中）,null,0,0,0,0,0,0,0"},
                }
                return {"result": {"structuredContent": values[name]}}

        client = FakeClient()
        result = recommend_live({}, city="北京", keyword="望京", client=client)
        self.assertEqual(result["mode"], "live_mcp")
        self.assertEqual(result["recommendation"]["name"], "巨无霸一人餐")
        self.assertEqual(result["recommendation"]["total"], "45.50")
        self.assertEqual(len(result["alternatives"]), 2)
        self.assertEqual(result["recommendation"]["nutrition"]["energyKcal"], 802)
        self.assertEqual(result["recommendation"]["nutrition"]["sodium"], 1126.0)
        self.assertTrue(all(len(alternative["items"]) == 3 for alternative in result["alternatives"]))
        self.assertTrue(all("source" in alternative["nutrition"] for alternative in result["alternatives"]))
        self.assertEqual(result["orderDraft"]["state"], "confirmation_required")
        self.assertFalse(result["orderDraft"]["writeToolsEnabled"])
        self.assertEqual(len(result["orderDraft"]["items"]), 3)
        self.assertEqual([call[0] for call in client.calls], [
            "query-nearby-stores", "query-meals", "query-meal-detail", "list-nutrition-foods"
        ])

    def test_live_selection_applies_budget_and_exclusions_before_scoring(self) -> None:
        meals = [
            {"code": "M1", "name": "巨无霸", "currentPrice": "26.5"},
            {"code": "M2", "name": "中薯条", "currentPrice": "11"},
            {"code": "M3", "name": "无糖可乐（中）", "currentPrice": "8"},
            {"code": "M4", "name": "麦香鸡", "currentPrice": "17"},
            {"code": "M5", "name": "柠檬红茶（中）", "currentPrice": "4"},
        ]
        preferences = {"budgetMax": 35, "exclusions": ["可乐"]}
        selected = _select_items(meals, preferences)
        self.assertEqual(len(selected), 3)
        self.assertLessEqual(sum(float(item["currentPrice"]) for item in selected), 35)
        self.assertTrue(all("可乐" not in item["name"] for item in selected))
        alternatives = _alternative_combinations(meals, selected, preferences)
        self.assertTrue(all(combo[3] <= 35 for combo in alternatives))
        self.assertTrue(all("可乐" not in "".join(item["name"] for item in combo[:3]) for combo in alternatives))

    def test_live_selection_reports_budget_conflict_instead_of_exceeding_budget(self) -> None:
        meals = [
            {"code": "M1", "name": "巨无霸", "currentPrice": "26.5"},
            {"code": "M2", "name": "中薯条", "currentPrice": "11"},
            {"code": "M3", "name": "无糖可乐（中）", "currentPrice": "8"},
        ]
        with self.assertRaisesRegex(LiveRecommendationError, "preference_conflict"):
            _select_items(meals, {"budgetMax": 30})

    def test_token_lifecycle_encrypts_and_rebinds_without_exposing_secret(self) -> None:
        first = "first-test-token"
        second = "second-test-token"
        vault = EncryptedTokenVault(b"9M6K2e7b1v8t3n4q5r6s7u8w9x0y1z2A3B4C5D6E7F8=")
        manager = TokenManager(vault, lambda token: token in {first, second})

        active = manager.bind("user-1", first)
        self.assertEqual(active.status, "active")
        self.assertEqual(manager.require_active_token("user-1"), first)
        self.assertEqual(manager.bind("user-1", "rejected-token").status, "active")
        self.assertEqual(manager.require_active_token("user-1"), first)
        rebound = manager.bind("user-1", second)
        self.assertEqual(rebound.status, "active")
        self.assertEqual(manager.require_active_token("user-1"), second)
        self.assertNotIn(first, repr(manager.metadata("user-1")))

        disconnected = manager.disconnect("user-1")
        self.assertEqual(disconnected.status, "disconnected")
        with self.assertRaises(TokenLifecycleError):
            manager.require_active_token("user-1")
        manager.delete("user-1")
        self.assertIsNone(manager.metadata("user-1"))


if __name__ == "__main__":
    unittest.main()
