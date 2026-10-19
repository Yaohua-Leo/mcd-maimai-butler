import unittest

from backend.agent_runtime import (
    AgentRuntime,
    AgentState,
    ReadOnlyToolBroker,
    ToolBrokerError,
    parse_intent,
)
from backend.provider_adapter import DeterministicProvider


class FakeMcpClient:
    def __init__(self) -> None:
        self.calls = []

    def call_read_only(self, name, arguments):
        self.calls.append((name, arguments))
        values = {
            "query-nearby-stores": {
                "code": 200,
                "data": [{"storeCode": "S1", "storeName": "望京演示店", "businessStatus": True}],
            },
            "query-meals": {
                "code": 200,
                "data": {
                    "meals": {
                        "M1": {"name": "巨无霸", "currentPrice": "26.5"},
                        "M2": {"name": "中薯条", "currentPrice": "11"},
                        "M3": {"name": "无糖可乐（中）", "currentPrice": "8"},
                    }
                },
            },
            "query-meal-detail": {"code": 200, "data": {"name": "巨无霸", "supportModify": False}},
            "list-nutrition-foods": {
                "code": 200,
                "data": "[3]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  巨无霸,null,2100,513,27,30,40,961,200\n  中薯条,null,1210,289,4,12,38,165,18\n  无糖可乐（中）,null,0,0,0,0,0,0,0",
            },
        }
        return {"result": {"structuredContent": values[name]}}


class AgentRuntimeTests(unittest.TestCase):
    def test_parser_extracts_explicit_chinese_constraints(self) -> None:
        intent = parse_intent("北京望京，预算30元，清淡一点，不要可乐")
        self.assertEqual(intent.city, "北京")
        self.assertEqual(intent.keyword, "望京")
        self.assertEqual(intent.budget_max, 30)
        self.assertEqual(intent.mood, "light")
        self.assertEqual(intent.exclusions, ["可乐"])
        self.assertEqual(intent.preferences["budget"], "standard")

    def test_live_runtime_clarifies_missing_location(self) -> None:
        runtime = AgentRuntime(ReadOnlyToolBroker(mode="live", client=FakeMcpClient()))
        result = runtime.handle("想吃清淡一点")
        self.assertEqual(result["state"], AgentState.CLARIFYING.value)
        self.assertEqual(result["response"]["mode"], "clarifying")
        self.assertIn("city", result["response"]["missingFields"])

    def test_read_only_broker_rejects_writes_before_network(self) -> None:
        client = FakeMcpClient()
        broker = ReadOnlyToolBroker(mode="live", client=client)
        with self.assertRaises(ToolBrokerError):
            broker.call("create-order", {})
        self.assertEqual(client.calls, [])

    def test_live_runtime_runs_recommendation_through_broker(self) -> None:
        client = FakeMcpClient()
        runtime = AgentRuntime(ReadOnlyToolBroker(mode="live", client=client))
        result = runtime.handle("\u5317\u4eac\u671b\u4eac\uff0c\u6e05\u6de1\u4e00\u70b9")
        self.assertEqual(result["state"], AgentState.RECOMMENDATION_READY.value)
        self.assertEqual(result["response"]["mode"], "live_mcp")
        self.assertEqual(result["response"]["agentTurn"]["writeToolsEnabled"], False)
        self.assertEqual([call[0] for call in client.calls], [
            "query-nearby-stores", "query-meals", "query-meal-detail", "list-nutrition-foods"
        ])
        self.assertEqual([call["name"] for call in result["toolCalls"]], [
            "query-nearby-stores", "query-meals", "query-meal-detail", "list-nutrition-foods"
        ])

    def test_selected_store_skips_second_store_search(self) -> None:
        client = FakeMcpClient()
        runtime = AgentRuntime(ReadOnlyToolBroker(mode="live", client=client))
        result = runtime.handle("清淡一点", context={
            "storeCode": "S1",
            "storeName": "已选门店",
            "city": "北京",
            "keyword": "望京",
        })
        self.assertEqual(result["state"], AgentState.RECOMMENDATION_READY.value)
        self.assertEqual([call[0] for call in client.calls], [
            "query-meals", "query-meal-detail", "list-nutrition-foods"
        ])

    def test_natural_language_order_request_stays_read_only(self) -> None:
        client = FakeMcpClient()
        runtime = AgentRuntime(ReadOnlyToolBroker(mode="live", client=client))
        result = runtime.handle("北京望京，帮我点一份清淡的")
        self.assertEqual(result["intent"]["goal"], "order_draft")
        self.assertEqual(result["response"]["agentTurn"]["writeToolsEnabled"], False)
        self.assertNotIn("create-order", [call[0] for call in client.calls])

    def test_provider_adapter_is_injected_without_changing_tool_policy(self) -> None:
        client = FakeMcpClient()
        provider = DeterministicProvider()
        runtime = AgentRuntime(ReadOnlyToolBroker(mode="live", client=client), provider=provider)
        result = runtime.handle("\u5317\u4eac\u671b\u4eac\uff0c\u9884\u7b9750\u5143")
        self.assertEqual(result["response"]["agentTurn"]["provider"], "deterministic-fallback")
        self.assertIn("50", result["response"]["agent"]["explanation"])
        self.assertEqual(result["response"]["agentTurn"]["writeToolsEnabled"], False)


    def test_constraint_conflict_is_explicit_and_does_not_degrade_to_fixture(self) -> None:
        client = FakeMcpClient()
        runtime = AgentRuntime(ReadOnlyToolBroker(mode="live", client=client))
        result = runtime.handle("\u5317\u4eac\u671b\u4eac\uff0c\u9884\u7b9730\u5143")
        self.assertEqual(result["state"], AgentState.CLARIFYING.value)
        self.assertEqual(result["response"]["mode"], "constraint_conflict")
        self.assertIn("\u4e0d\u8d85\u8fc7", result["response"]["reason"])
        self.assertNotIn("recommendation", result["response"])

    def test_parser_extracts_dietary_constraint(self) -> None:
        intent = parse_intent("\u5317\u4eac\u671b\u4eac\uff0c\u7d20\u98df\uff0c\u4e0d\u8981\u8fa3")
        self.assertEqual(intent.dietary, ["\u7d20\u98df", "\u4e0d\u8fa3"])


if __name__ == "__main__":
    unittest.main()
