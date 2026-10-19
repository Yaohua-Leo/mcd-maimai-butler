"""Read-only smoke test for the McDonald's Streamable HTTP MCP server.

This script reads MCD_MCP_TOKEN from the process environment and never prints
the token, request headers, or tool result contents.
"""

import json
import os
import sys
import urllib.error
import urllib.request


URL = "https://mcp.mcd.cn"
TOKEN = os.environ.get("MCD_MCP_TOKEN", "")


def post(payload, session_id=None, protocol_version="2025-06-18"):
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": protocol_version,
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    request = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, dict(response.headers), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read().decode("utf-8", "replace")
    except urllib.error.URLError as error:
        # Keep connectivity failures concise and never include request
        # headers, the token, or a response body in the smoke-test output.
        reason = getattr(error, "reason", "network_error")
        return "network_error", {}, str(reason)


def body_json(text):
    text = text.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    return json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
    return {}


if not TOKEN:
    print("MCD_MCP_TOKEN: missing")
    sys.exit(2)

status, headers, text = post(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "mcd-mcp-smoke-test", "version": "1.0"},
        },
    }
)
print(f"initialize_http={status}")
init = body_json(text)
if not isinstance(status, int) or status >= 400 or "error" in init:
    error_code = status if not isinstance(status, int) else init.get("error", {}).get("code", "http")
    print(f"initialize_ok=False error_code={error_code}")
    sys.exit(1)

session_id = headers.get("Mcp-Session-Id")
print(f"session_id_present={bool(session_id)}")

initialized_status, _, _ = post(
    {"jsonrpc": "2.0", "method": "notifications/initialized"}, session_id
)
print(f"initialized_http={initialized_status}")

status, _, text = post(
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session_id
)
listed = body_json(text)
tools = listed.get("result", {}).get("tools", [])
names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
print(f"tools_list_http={status} tool_count={len(names)} now_time_info_present={'now-time-info' in names}")
if status >= 400 or "now-time-info" not in names:
    sys.exit(1)

status, _, text = post(
    {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": "now-time-info", "arguments": {}},
    },
    session_id,
)
called = body_json(text)
is_error = "error" in called or called.get("result", {}).get("isError", False)
print(f"now_time_info_http={status} tool_error={is_error}")
sys.exit(0 if status < 400 and not is_error else 1)
