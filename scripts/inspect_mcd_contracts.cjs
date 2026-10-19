// Read-only protocol metadata discovery. Never executes a business tool.
const fs = require('node:fs');
const path = require('node:path');
const wanted = new Set(['calculate-price', 'create-order', 'cancel-order', 'query-order', 'order-list', 'query-meal-detail']);
async function main() {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) throw Error('MCD_MCP_TOKEN unavailable');
  let session;
  async function post(payload) {
    const response = await fetch('https://mcp.mcd.cn', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(25000)
    });
    session = response.headers.get('Mcp-Session-Id') || session;
    if (!response.ok) throw Error(`Metadata HTTP ${response.status}`);
    const raw = await response.text();
    if (!raw.trim()) return {};
    let body;
    try { body = JSON.parse(raw); } catch (_) {
      for (const line of raw.split(/\r?\n/)) if (line.startsWith('data:')) {
        try { body = JSON.parse(line.slice(5)); break; } catch (_) {}
      }
    }
    if (!body || body.error) throw Error('Metadata protocol failure');
    return body;
  }
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'maimai-contract-check', version: '1.0' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  let cursor; const all = [];
  do {
    const result = await post({ jsonrpc: '2.0', id: all.length + 2, method: 'tools/list', params: cursor ? { cursor } : {} });
    all.push(...(result.result?.tools || [])); cursor = result.result?.nextCursor;
    if (all.length > 500) throw Error('Unexpected metadata pagination');
  } while (cursor);
  const tools = all.filter(tool => wanted.has(tool.name));
  const output = { source: 'https://mcp.mcd.cn tools/list', checkedAt: new Date().toISOString(), discoveryOnly: true, tools };
  const target = path.resolve(__dirname, '../specs/agent-checkout/mcp-contracts.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ totalTools: all.length, saved: tools.map(tool => tool.name), missing: [...wanted].filter(name => !tools.some(tool => tool.name === name)) }));
}
main().catch(error => { console.error(error.name === 'Error' ? error.message : 'Metadata query failed'); process.exitCode = 1; });
