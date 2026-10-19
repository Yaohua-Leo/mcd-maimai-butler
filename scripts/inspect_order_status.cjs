// Read-only MCP diagnostic. Outputs state labels and field names only.
// Credentials, order IDs, locations, products, amounts and payment URLs stay in memory.
'use strict';
const { normalizeOrderStatus } = require('../cloudfunctions/mcd-token/checkout');
async function main() {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) throw new Error('MCD_MCP_TOKEN unavailable');
  let session;
  async function post(method, params, id) {
    const response = await fetch('https://mcp.mcd.cn', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(id ? { id } : {}) }), signal: AbortSignal.timeout(30000) });
    session = response.headers.get('Mcp-Session-Id') || session;
    if (!response.ok) throw new Error('MCP HTTP ' + response.status);
    const raw = await response.text();
    if (!raw.trim()) return {};
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
      for (const line of raw.split(/\r?\n/)) if (line.startsWith('data:')) { try { parsed = JSON.parse(line.slice(5)); break; } catch (_) {} }
    }
    if (!parsed || parsed.error || parsed.result?.isError) throw new Error('MCP read failed');
    return parsed.result;
  }
  function unwrap(result) {
    if (result?.structuredContent) return result.structuredContent;
    for (const item of result?.content || []) if (item.type === 'text') { try { return JSON.parse(item.text); } catch (_) {} }
    return result;
  }
  const safe = value => typeof value === 'number' ? value : typeof value === 'string' && /^[\u4e00-\u9fffA-Za-z0-9 _·-]{0,32}$/.test(value) ? value : value == null ? null : '[unrecognized]';
  const status = item => ({ orderStatus: safe(item.orderStatus), status: safe(item.status), normalizedStatus: normalizeOrderStatus(item), fields: Object.keys(item).filter(key => /status|cancel|pay/i.test(key)) });
  await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'maimai-status-readonly', version: '1.0' } }, 1);
  await post('notifications/initialized');
  const listResult = unwrap(await post('tools/call', { name: 'order-list', arguments: {} }, 2));
  if (listResult?.code !== undefined && ![0, 200].includes(listResult.code)) throw new Error('Order list unavailable');
  const list = listResult?.data?.list;
  if (!Array.isArray(list)) throw new Error('Order list shape mismatch');
  const selected = list.slice(0, 3);
  const output = { checkedAt: new Date().toISOString(), source: 'MCD_MCP_TOKEN account read-only', count: list.length, listStates: selected.map(status), detailStates: [] };
  for (const row of selected) {
    if (!row.orderId) continue;
    const detail = unwrap(await post('tools/call', { name: 'query-order', arguments: { orderId: String(row.orderId) } }, 3 + output.detailStates.length));
    if (!detail?.data || String(detail.data.orderId) !== String(row.orderId)) throw new Error('Order detail mismatch');
    output.detailStates.push(status(detail.data));
  }
  console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(['MCD_MCP_TOKEN unavailable', 'MCP read failed', 'Order list unavailable', 'Order list shape mismatch', 'Order detail mismatch'].includes(error.message) || /^MCP HTTP \d+$/.test(error.message) ? error.message : 'Read-only status inspection failed'); process.exitCode = 1; });
