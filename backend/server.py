"""Small local HTTP server for the recommendation prototype.

Run from E:\\MM1 with ``python -m backend.server``. Fixture recommendations
are the default; the live read-only route is an explicit opt-in and never
invokes a write tool.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .recommendation import recommend
from .live_recommendation import LiveRecommendationError, recommend_live
from .agent_runtime import AgentRuntime, ReadOnlyToolBroker
from .provider_adapter import DeterministicProvider, ProviderUnavailableError, create_provider


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "MaimaiFixture/0.1"

    def _send(self, status: int, value: Any) -> None:
        body = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler API
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/health":
            self._send(
                200,
                {
                    "status": "ok",
                    "mode": "fixture",
                    "mcp": "optional_live_read_only",
                    "agentRuntime": True,
                    "orderWritesEnabled": False,
                },
            )
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path not in ("/api/recommend", "/api/recommend-live", "/api/agent"):
            self._send(404, {"error": "not_found"})
            return
        live_requested = self.path == "/api/recommend-live" or (
            self.path == "/api/agent" and str(self.headers.get("X-MCD-Agent-Mode", "")).lower() == "live"
        )
        if live_requested and os.environ.get("MCD_MCP_LIVE_MODE") != "1":
            self._send(503, {"error": "live_mode_disabled", "message": "set MCD_MCP_LIVE_MODE=1 in the backend process to opt in"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            if self.path == "/api/agent":
                message = payload.get("message", payload.get("text", ""))
                if not isinstance(message, str) or not message.strip():
                    raise ValueError("message must be a non-empty string")
                context = payload.get("context") or {}
                if not isinstance(context, dict):
                    raise ValueError("context must be a JSON object")
                mode = "live" if live_requested else "fixture"
                provider_name = payload.get("provider")
                if provider_name is not None and not isinstance(provider_name, str):
                    raise ValueError("provider must be a string")
                provider_error = None
                try:
                    provider = create_provider(provider_name)
                except ProviderUnavailableError as exc:
                    provider = DeterministicProvider()
                    provider_error = str(exc)
                runtime = AgentRuntime(ReadOnlyToolBroker(mode=mode), provider=provider)
                response = runtime.handle(message, context=context)
                if provider_error:
                    response["providerError"] = provider_error
                self._send(200, response)
                return
            preferences = payload.get("preferences") or {}
            if not isinstance(preferences, dict):
                raise ValueError("preferences must be a JSON object")
            location = payload.get("locationLabel") or "通用菜单快照"
            if self.path == "/api/recommend-live":
                city = str(payload.get("city") or "").strip()
                keyword = str(payload.get("keyword") or "").strip()
                if not city or not keyword:
                    raise ValueError("city and keyword are required for live MCP mode")
                be_type = int(payload.get("beType") or 1)
                if be_type not in (1, 2, 5, 6):
                    raise ValueError("beType must be 1, 2, 5, or 6")
                response = recommend_live(
                    preferences,
                    city=city,
                    keyword=keyword,
                    be_type=be_type,
                )
            else:
                response = recommend(preferences, location_label=str(location))
        except (ValueError, TypeError, json.JSONDecodeError, LiveRecommendationError) as exc:
            self._send(400, {"error": "invalid_request", "message": str(exc)})
            return
        self._send(200, response)

    def log_message(self, format: str, *args: object) -> None:
        # Keep local logs free of request bodies, tokens, addresses, and order data.
        print("[fixture-server] " + format % args)


def main() -> None:
    address = ("127.0.0.1", 8787)
    print(f"麦麦管家 fixture backend: http://{address[0]}:{address[1]}")
    print("仅提供本地推荐；MCP 和订单写工具均未启用。")
    ThreadingHTTPServer(address, Handler).serve_forever()


if __name__ == "__main__":
    main()
