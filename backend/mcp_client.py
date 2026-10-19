"""Read-only Streamable HTTP MCP client.

The client is intentionally separate from the local fixture HTTP server. It
reads ``MCD_MCP_TOKEN`` only from the process environment, never returns the
token, and refuses state-changing tools. A production service still needs
credential storage, user isolation, audit redaction, and the G1/G2 gates.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


READ_ONLY_TOOLS = frozenset(
    {
        "list-nutrition-foods",
        "query-nearby-stores",
        "query-meals",
        "query-meal-detail",
        "campaign-calendar",
        "now-time-info",
    }
)


class McpClientError(RuntimeError):
    """A transport, protocol, or allowlist error."""


def _decode_response(text: str) -> dict[str, Any]:
    text = text.strip()
    if not text:
        return {}
    try:
        decoded = json.loads(text)
        return decoded if isinstance(decoded, dict) else {}
    except json.JSONDecodeError:
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    decoded = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    return decoded
    return {}


class ReadOnlyMcpClient:
    """Minimal MCP client for queries already approved by the project."""

    def __init__(self, *, url: str = "https://mcp.mcd.cn", token: str | None = None, timeout: int = 20):
        self.url = url
        self._token = token if token is not None else os.environ.get("MCD_MCP_TOKEN", "")
        self.timeout = timeout
        self._session_id: str | None = None
        self._next_id = 1

    @property
    def has_token(self) -> bool:
        return bool(self._token)

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._token:
            raise McpClientError("MCD_MCP_TOKEN is not set")
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8", "replace")
                self._session_id = response.headers.get("Mcp-Session-Id", self._session_id)
                status = response.status
        except urllib.error.HTTPError as error:
            # Preserve only the status; never include response bodies that may
            # contain account data in an exception or log.
            raise McpClientError(f"MCP HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise McpClientError(f"MCP network error: {error.reason}") from error
        if status >= 400:
            raise McpClientError(f"MCP HTTP {status}")
        result = _decode_response(raw)
        if "error" in result:
            error = result.get("error") or {}
            raise McpClientError(f"MCP protocol error {error.get('code', 'unknown')}")
        return result

    def initialize(self) -> dict[str, Any]:
        result = self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "maimai-butler", "version": "0.1.0"},
                },
            }
        )
        self._next_id += 1
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return result

    def list_tools(self) -> list[dict[str, Any]]:
        result = self._post(
            {"jsonrpc": "2.0", "id": self._next_id, "method": "tools/list", "params": {}}
        )
        self._next_id += 1
        tools = result.get("result", {}).get("tools", [])
        return [tool for tool in tools if isinstance(tool, dict)]

    def call_read_only(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        if name not in READ_ONLY_TOOLS:
            raise McpClientError(f"tool is not in read-only allowlist: {name}")
        result = self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        self._next_id += 1
        return result
