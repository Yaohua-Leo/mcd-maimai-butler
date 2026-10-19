"use strict";

const crypto = require("node:crypto");
const { isIP } = require('node:net');
const cloudbase = require("@cloudbase/node-sdk");
const { resolveNutrition, summarizeNutrition } = require("./nutrition");
const { createStateStore, stateError } = require('./state-store');
const { createConversationService, ROLES, LABELS } = require('./conversation');
const { createPreferenceService } = require('./preferences');
const { createCheckoutService } = require('./checkout');
const { createOrderAccess } = require('./order-access');

const TABLE = "mcd_mcp_tokens";
const MCP_URL = "https://mcp.mcd.cn";
const OWNER_FIELDS = "owner_id,status,bound_at,last_validated_at,invalidated_at,disconnected_at";
const READ_TOOLS = new Set(['now-time-info', 'query-nearby-stores', 'query-meals', 'query-meal-detail', 'list-nutrition-foods', 'campaign-calendar', 'calculate-price', 'query-order', 'order-list']);
const WRITE_TOOLS = new Set(['create-order', 'cancel-order']);
const WRITE_AUTHORIZATION = Symbol('confirmed checkout operation');

function now() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function fail(message) {
  const error = new Error(message);
  error.safe = true;
  throw error;
}

function ownerIdFromContext(event, context) {
  // Only platform context / SDK identity is authoritative. Ignore event.userInfo.
  let id = context?.OPENID || context?.openid;
  if (!id) {
    try { id = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID }).auth().getUserInfo().openId; } catch (_) {}
  }
  if (typeof id !== "string" || !id.trim()) fail("CloudBase user identity is required");
  return id.trim();
}

function encryptionKey() {
  const encoded = process.env.MCD_TOKEN_ENCRYPTION_KEY || "";
  if (!encoded) fail("token encryption is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) fail("token encryption is not configured");
  return key;
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptToken(encoded) {
  const parts = String(encoded || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("stored token is invalid");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function parseMcpBody(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch (_) {}
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch (_) {}
  }
  return {};
}

async function mcpPost(token, payload, sessionId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
  const body = parseMcpBody(await response.text());
  if (!response.ok || body.error) return null;
  return { body, sessionId: response.headers.get("Mcp-Session-Id") || sessionId };
}

async function validateMcpToken(token) {
  if (typeof token !== "string" || !token.trim()) return false;
  const init = await mcpPost(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "maimai-butler-cloud-function", version: "0.1.0" },
    },
  });
  if (!init) return false;
  const initialized = await mcpPost(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  if (!initialized) return false;
  const checked = await mcpPost(token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "now-time-info", arguments: {} },
  }, initialized.sessionId);
  return Boolean(checked && !checked.body.error && !checked.body.result?.isError);
}

function dbModels() {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (!env) fail("CloudBase environment is not configured");
  const models = cloudbase.init({ env, timeout: 60000 }).models;
  if (!models || typeof models.$runSQL !== "function") {
    throw new Error("MySQL data model is not configured");
  }
  return models;
}

function aiModel() {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (!env) fail("CloudBase environment is not configured");
  const app = cloudbase.init({ env, timeout: 60000 });
  const ai = app.ai();
  const provider = process.env.MAIMAI_HY3_PROVIDER || "hunyuan-v3";
  return ai.createModel(provider);
}

function safeProviderUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch (_) { fail('provider URL is invalid'); }
  const host = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
  const address = host.replace(/^\[|\]$/g, '');
  // Require a hostname; rejecting all IP literals also covers alternate IPv4
  // spellings and IPv4-mapped IPv6 without an incomplete private-IP parser.
  if (parsed.protocol !== 'https:' || !host || parsed.username || parsed.password || isIP(address) || host === 'localhost' || host.endsWith('.localhost')) {
    fail('provider URL must use an HTTPS hostname without embedded credentials');
  }
  return raw.replace(/\/+$/, '');
}

function normalizeProvider(value) {
  return value === 'openai-compatible' ? 'openai-compatible' : 'hunyuan-v3';
}

async function selectProviderConfig(ownerId) {
  const result = await dbModels().$runSQL(
    `SELECT provider, provider_model, provider_base_url, encrypted_provider_key FROM \`${TABLE}\` WHERE owner_id = {{ownerId}} LIMIT 1`,
    { ownerId },
  );
  const rows = result?.data?.executeResultList;
  if (!Array.isArray(rows)) throw new Error('provider metadata query failed');
  const row = rows[0] || {};
  const provider = normalizeProvider(row.provider || process.env.MAIMAI_HY3_PROVIDER || 'hunyuan-v3');
  return {
    provider,
    model: String(row.provider_model || (provider === 'hunyuan-v3' ? process.env.MAIMAI_HY3_MODEL || 'hy3-preview' : '')),
    baseUrl: provider === 'openai-compatible' ? safeProviderUrl(row.provider_base_url || '') : '',
    encryptedApiKey: String(row.encrypted_provider_key || ''),
  };
}

function publicProviderConfig(config) {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKeyConfigured: Boolean(config.encryptedApiKey),
  };
}

async function providerStatus(ownerId) {
  return { ok: true, provider: publicProviderConfig(await selectProviderConfig(ownerId)) };
}

async function saveProviderConfig(ownerId, event) {
  const provider = normalizeProvider(event?.provider);
  const model = typeof event?.model === 'string' ? event.model.trim().slice(0, 128) : '';
  const baseUrl = provider === 'openai-compatible' ? safeProviderUrl(event?.baseUrl) : '';
  const apiKey = typeof event?.apiKey === 'string' ? event.apiKey : '';
  if (!model) fail('provider model is required');
  if (provider === 'openai-compatible' && !baseUrl) fail('provider URL is required');
  const existing = await selectProviderConfig(ownerId);
  if (provider === 'openai-compatible' && !apiKey && (existing.provider !== provider || existing.baseUrl !== baseUrl)) {
    fail('a new provider API key is required when changing the provider URL');
  }
  const encryptedApiKey = provider === 'openai-compatible'
    ? (apiKey ? encryptToken(apiKey) : existing.encryptedApiKey)
    : '';
  if (provider === 'openai-compatible' && !encryptedApiKey) fail('provider API key is required');
  const timestamp = now();
  const models = dbModels();
  const metadata = await selectMetadata(ownerId);
  if (metadata) {
    await models.$runSQL(
      `UPDATE \`${TABLE}\`
       SET provider = {{provider}}, provider_model = {{model}}, provider_base_url = {{baseUrl}}, encrypted_provider_key = {{encryptedApiKey}}, provider_updated_at = {{updatedAt}}, updated_at = {{updatedAt}}
       WHERE owner_id = {{ownerId}}`,
      { provider, model, baseUrl, encryptedApiKey, updatedAt: timestamp, ownerId },
    );
  } else {
    await models.$runSQL(
      `INSERT INTO \`${TABLE}\`
       (_id, _openid, owner_id, encrypted_token, status, provider, provider_model, provider_base_url, encrypted_provider_key, provider_updated_at, created_at, updated_at)
       VALUES ({{id}}, {{openid}}, {{ownerId}}, '', 'disconnected', {{provider}}, {{model}}, {{baseUrl}}, {{encryptedApiKey}}, {{updatedAt}}, {{updatedAt}}, {{updatedAt}})`,
      { id: ownerId, openid: ownerId, ownerId, provider, model, baseUrl, encryptedApiKey, updatedAt: timestamp },
    );
  }
  return { ok: true, provider: publicProviderConfig({ provider, model, baseUrl, encryptedApiKey }) };
}

async function openAiCompatibleGenerate(config, messages) {
  const apiKey = decryptToken(config.encryptedApiKey);
  const endpoint = /\/chat\/completions$/i.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error('provider request failed');
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('provider returned empty text');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonText(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
}

async function hy3Generate(ownerId, messages) {
  const config = await selectProviderConfig(ownerId);
  if (config.provider === 'openai-compatible') return openAiCompatibleGenerate(config, messages);
  const result = await aiModel().generateText({
    model: config.model || process.env.MAIMAI_HY3_MODEL || 'hy3-preview',
    messages,
  });
  const text = typeof result?.text === "string" ? result.text : "";
  if (!text) throw new Error("HY3 returned empty text");
  return text;
}

function safeAgentContext(event) {
  const context = event?.context && typeof event.context === "object" ? event.context : {};
  const rawSettings = context.settings && typeof context.settings === "object" ? context.settings : {};
  return {
    city: typeof context.city === "string" ? context.city : "",
    keyword: typeof context.keyword === "string" ? context.keyword : "",
    storeCode: typeof context.storeCode === "string" ? context.storeCode : "",
    storeName: typeof context.storeName === "string" ? context.storeName : "",
    storeAddress: typeof context.storeAddress === "string" ? context.storeAddress : "",
    beCode: typeof context.beCode === "string" ? context.beCode : "",
    beType: Number(context.beType) === 5 ? 5 : 1,
    settings: {
      budgetMax: rawSettings.budgetMax !== null && rawSettings.budgetMax !== undefined && Number.isFinite(Number(rawSettings.budgetMax)) ? Number(rawSettings.budgetMax) : null,
      mood: ["light", "satisfying", "balanced"].includes(rawSettings.mood) ? rawSettings.mood : null,
      exclusions: Array.isArray(rawSettings.exclusions) ? rawSettings.exclusions.filter((item) => typeof item === "string").slice(0, 6) : [],
      dietary: Array.isArray(rawSettings.dietary) ? rawSettings.dietary.filter((item) => typeof item === "string").slice(0, 6) : [],
    },
  };
}

async function parseHy3Intent(ownerId, message, context) {
  const content = await hy3Generate(ownerId, [
    { role: "system", content: "你是麦当劳点餐 Agent 的意图解析器。只输出 JSON，不输出 Markdown。只能提取用户明确说出的信息，不得猜价格、营养、库存或门店。字段：city、keyword、beType(1或5)、budgetMax(number或null)、mood(light/satisfying/balanced或null)、exclusions(string[]), dietary(string[]), goal(recommend或order_draft)。" },
    { role: "user", content: JSON.stringify({ message, context }, null, 0) },
  ]);
  const parsed = parseJsonText(content);
  if (!parsed || typeof parsed !== "object") throw new Error("HY3 intent was not valid JSON");
  const city = typeof parsed.city === "string" ? parsed.city.trim() : context.city;
  const keyword = typeof parsed.keyword === "string" ? parsed.keyword.trim() : context.keyword;
  const beType = Number(parsed.beType) === 5 ? 5 : context.beType;
  const budgetMax = parsed.budgetMax !== null && parsed.budgetMax !== "" && Number.isFinite(Number(parsed.budgetMax)) ? Number(parsed.budgetMax) : context.settings.budgetMax;
  const mood = ["light", "satisfying", "balanced"].includes(parsed.mood) ? parsed.mood : context.settings.mood;
  const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 6) : [];
  return { city, keyword, beType, budgetMax, mood, exclusions: list(parsed.exclusions).length ? list(parsed.exclusions) : context.settings.exclusions, dietary: list(parsed.dietary).length ? list(parsed.dietary) : context.settings.dietary, goal: parsed.goal === "order_draft" ? "order_draft" : "recommend" };
}

async function hy3Explain(ownerId, recommendation, intent) {
  try {
    return (await hy3Generate(ownerId, [
      { role: "system", content: "你是麦当劳推荐 Agent。用简短中文解释推荐理由，只能使用输入事实，不得新增价格、营养、门店或支付状态。" },
      { role: "user", content: JSON.stringify({ intent, recommendation }, null, 0) },
    ])).trim();
  } catch (_) {
    return "已根据本次实时 MCP 菜单和你的偏好生成推荐。";
  }
}

async function hy3ExplainPlans(ownerId, plans, intent) {
  const fallback = plans.map((plan) => {
    const names = Array.isArray(plan?.items) ? plan.items.map((item) => item.name).filter(Boolean) : [];
    return names.length ? `推荐${names.join("、")}组成的一人餐，符合本次门店和偏好条件。` : "该方案来自本次门店实时菜单。";
  });
  try {
    const content = await hy3Generate(ownerId, [
      { role: "system", content: "你是麦当劳推荐 Agent。为每个方案生成一句对应的中文推荐理由。只能使用输入事实，不得新增价格、营养、门店或支付状态。只输出 JSON：{\"reasons\":[\"...\"]}，顺序必须与方案一致。" },
      { role: "user", content: JSON.stringify({ intent, plans }, null, 0) },
    ]);
    const parsed = parseJsonText(content);
    if (Array.isArray(parsed?.reasons) && parsed.reasons.length >= plans.length) {
      return parsed.reasons.slice(0, plans.length).map((reason, index) => typeof reason === "string" && reason.trim() ? reason.trim() : fallback[index]);
    }
  } catch (_) {}
  return fallback;
}

async function agent(ownerId, event) {
  const context = safeAgentContext(event);
  if (!context.storeCode.trim() && !event.conversationId) return { ok: true, mode: 'store_required', question: '请先确认餐厅，再让 Agent 选餐。' };
  return conversationService().turn(ownerId, event, context);
}

function stateStore() {
  return createStateStore({ models: dbModels(), seal: encryptToken, open: decryptToken });
}

async function parseRevisionPatch(ownerId, message, previous) {
  const content = await hy3Generate(ownerId, [
    { role: 'system', content: '你是点餐要求补丁解析器，只输出JSON。仅包含本句话明确修改的字段，绝不能把未提到的预算/排除项清空。支持budgetMax(number，明确不限预算才null)、cheaperBy(便宜多少元)、mood(light/balanced/satisfying)、addExclusions/removeExclusions、addDietary/removeDietary、changeRoles(main/side/drink数组)、preferredByRole({main/side/drink:简短餐品名或无糖等关键词})、omitRoles(明确不要的side/drink)、restoreRoles(重新加回角色)、goal(recommend/order_draft)。局部换餐必须填写changeRoles和preferredByRole；例如饮料换成无糖是drink和无糖，其他角色不修改。只有明确取消旧要求才填写remove字段。无法判断时needsClarification=true并给question。不要生成价格、营养、门店、凭据、订单状态或工具调用。' },
    { role: 'user', content: JSON.stringify({ message, current: previous }, null, 0) }
  ]);
  const parsed = parseJsonText(content);
  if (!parsed) throw stateError('intent_unavailable', '暂时没能理解这次修改，请换个说法重试');
  return parsed;
}

function conversationService() {
  return createConversationService({ store: stateStore(), parsePatch: parseRevisionPatch, recommend: liveRecommendation, explain: hy3ExplainPlans,
    loadPreferences: owner => createPreferenceService({ store: stateStore() }).read(owner) });
}

function checkoutService() {
  const gate = owner => orderAccessService().read(owner);
  const call = async (owner, name, args, write = false) => {
    const token = await selectStoredToken(owner);
    if (!token) throw stateError('token_required', '请先链接麦当劳账号');
    if (write && !(await gate(owner)).enabled) throw stateError('write_disabled', '当前账号的下单权限已关闭或到期');
    return requireMcpSuccess(await mcpTool(token, name, args, write ? WRITE_AUTHORIZATION : undefined), name);
  };
  return createCheckoutService({ store: stateStore(), conversations: conversationService(), gate,
    readTool: (owner, name, args) => call(owner, name, args), writeTool: (owner, name, args) => call(owner, name, args, true),
    paymentHosts: ['mcd.cn', 'mcdonalds.com.cn', ...String(process.env.MCD_PAYMENT_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(host => /^[a-z0-9.-]+$/.test(host))] });
}

async function selectMetadata(ownerId) {
  const result = await dbModels().$runSQL(
    `SELECT ${OWNER_FIELDS} FROM \`${TABLE}\` WHERE owner_id = {{ownerId}} LIMIT 1`,
    { ownerId },
  );
  const rows = result?.data?.executeResultList;
  if (!Array.isArray(rows)) throw new Error("token metadata query failed");
  return rows[0] || null;
}

async function selectStoredToken(ownerId) {
  const result = await dbModels().$runSQL(
    `SELECT encrypted_token FROM \`${TABLE}\` WHERE owner_id = {{ownerId}} AND status = 'active' LIMIT 1`,
    { ownerId },
  );
  const rows = result?.data?.executeResultList;
  if (!Array.isArray(rows)) throw new Error("token metadata query failed");
  return rows[0]?.encrypted_token ? decryptToken(rows[0].encrypted_token) : null;
}

function orderAccessService() {
  return createOrderAccess({
    models: dbModels(),
    isBoundUser: async owner => Boolean(await selectStoredToken(owner))
  });
}

function unwrapMcp(value) {
  if (!value || typeof value !== "object") return null;
  if (value.structuredContent && typeof value.structuredContent === "object") return value.structuredContent;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (typeof item?.text !== "string") continue;
      try { return JSON.parse(item.text); } catch (_) {}
      for (const line of item.text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
        try { return JSON.parse(trimmed); } catch (_) {}
      }
    }
  }
  if (value.result && typeof value.result === "object") return unwrapMcp(value.result);
  return value;
}

async function mcpTool(token, name, args, authorization) {
  if (!READ_TOOLS.has(name) && !(WRITE_TOOLS.has(name) && authorization === WRITE_AUTHORIZATION)) fail('MCP tool requires explicit confirmed checkout authorization');
  const init = await mcpPost(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "maimai-butler-cloud-function", version: "0.2.0" },
    },
  });
  if (!init) throw new Error("MCP initialize failed");
  const initialized = await mcpPost(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  if (!initialized) throw new Error("MCP session initialization failed");
  const checked = await mcpPost(token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args || {} },
  }, initialized.sessionId);
  if (!checked || checked.body?.error || checked.body?.result?.isError) throw new Error(`MCP ${name} failed`);
  return unwrapMcp(checked.body?.result);
}

function requireMcpSuccess(value, name) {
  if (!value || (value.code !== undefined && ![0, 200].includes(value.code))) throw new Error(`MCP ${name} returned an error`);
  return value;
}

function normalizeStore(store) {
  if (!store || typeof store !== "object" || !store.storeCode) return null;
  const latitude = Number(store.latitude ?? store.lat ?? store.location?.latitude);
  const longitude = Number(store.longitude ?? store.lng ?? store.location?.longitude);
  const hasPoint = Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
  return {
    storeCode: String(store.storeCode),
    storeName: String(store.storeName || "未命名门店"),
    address: typeof store.address === "string" ? store.address : "",
    distance: Number.isFinite(Number(store.distance)) ? Number(store.distance) : null,
    latitude: hasPoint ? latitude : null,
    longitude: hasPoint ? longitude : null,
    businessStatus: store.businessStatus !== false,
    businessStartTime: typeof store.businessStartTime === "string" ? store.businessStartTime : "",
    businessEndTime: typeof store.businessEndTime === "string" ? store.businessEndTime : "",
    reservation: store.reservation === true,
    beCode: typeof store.beCode === "string" ? store.beCode : "",
  };
}

function nearbyStoreArgs(event) {
  const city = typeof event?.city === "string" ? event.city.trim() : "";
  const keyword = typeof event?.keyword === "string" ? event.keyword.trim() : "";
  const beType = Number(event?.beType) === 5 ? 5 : 1;
  if (!city || !keyword) throw new Error("city and keyword are required");
  return { searchType: 2, city, keyword, beType };
}

async function nearbyStores(ownerId, event) {
  const token = await selectStoredToken(ownerId);
  if (!token) return { ok: false, error: "MCP token is not linked" };
  const args = nearbyStoreArgs(event);
  const response = requireMcpSuccess(await mcpTool(token, "query-nearby-stores", args), "query-nearby-stores");
  const stores = (Array.isArray(response.data) ? response.data : [])
    .map(normalizeStore)
    .filter(Boolean)
    .sort((a, b) => Number(b.businessStatus) - Number(a.businessStatus) || (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 8);
  if (!stores.length) throw new Error("MCP store data is incomplete");
  return {
    ok: true,
    mode: "live_mcp",
    dataStatus: "实时 MCP",
    updatedAt: "本次查询",
    city: args.city,
    keyword: args.keyword,
    beType: args.beType,
    stores,
    nearestStoreCode: stores[0]?.storeCode || "",
    sortPolicy: "营业门店优先；同类按 MCP distance 升序",
  };
}

function asMeals(value) {
  const meals = value?.data?.meals;
  if (!meals || typeof meals !== "object") throw new Error("MCP menu data is incomplete");
  return Object.entries(meals).map(([code, meal]) => ({ code, ...(meal || {}) })).filter((meal) => meal.name);
}

function mealPriceValue(meal) {
  const value = meal?.currentPrice ?? meal?.price;
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function preferenceTerms(value) {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
}

const MEAT_TERMS = ["鸡", "牛", "猪", "肉", "培根", "鱼", "虾", "火腿", "腊肉"];
const SPICY_TERMS = ["辣", "麻辣", "香辣", "藤椒", "黑椒"];
const CONDIMENT_TERMS = ["酱", "酱料", "蘸酱", "调味", "沙拉酱", "番茄酱", "山葵", "芥末", "糖醋", "辣椒酱", "芝士酱", "奶油酱"];
const MAIN_TERMS = ["堡", "汉堡", "麦香鸡", "巨无霸", "板烧", "鸡腿", "牛肉", "鱼柳", "卷", "饭", "派"];

function mealAllowed(meal, preferences) {
  const name = String(meal?.name || "").toLowerCase();
  if (preferenceTerms(preferences?.exclusions).some((term) => name.includes(term))) return false;
  const dietary = preferenceTerms(preferences?.dietary);
  if (dietary.some((term) => ["素食", "纯素", "vegan", "vegetarian", "不吃肉"].includes(term)) && MEAT_TERMS.some((term) => name.includes(term))) return false;
  if (dietary.some((term) => ["不辣", "少辣", "无辣", "不要辣", "清淡", "no spicy"].includes(term)) && SPICY_TERMS.some((term) => name.includes(term))) return false;
  return true;
}

function constraintRequested(preferences) {
  return preferences?.budgetMax !== null && preferences?.budgetMax !== undefined
    || ["light", "standard"].includes(preferences?.budget)
    || preferenceTerms(preferences?.exclusions).length > 0
    || preferenceTerms(preferences?.dietary).length > 0
    || ["light", "satisfying", "balanced"].includes(preferences?.mood);
}

function moodScore(combo, preferences) {
  if (!["light", "satisfying"].includes(preferences?.mood)) return 0;
  const names = combo.items.map((item) => String(item?.name || "")).join(" ");
  const positive = preferences.mood === "light" ? ["玉米", "沙拉", "水果", "牛奶", "纯净水", "红茶", "板烧"] : ["巨无霸", "双层", "牛堡", "鸡腿堡", "麦乐鸡"];
  const negative = preferences.mood === "light" ? ["双层", "巨无霸", "芝士", "培根", "辣"] : ["沙拉", "玉米", "纯净水"];
  return positive.reduce((score, term) => score + names.split(term).length - 1, 0) * 2 - negative.reduce((score, term) => score + names.split(term).length - 1, 0);
}

function mealCategories(meals, preferences = {}) {
  const drinks = [], sides = [], mains = [];
  for (const meal of meals) {
    if (!mealAllowed(meal, preferences)) continue;
    const name = String(meal?.name || "");
    if (["套餐", "组合", "件套", "人餐", "分享", "全家", "派", "冰淇淋", "新地", "麦旋风"].some((term) => name.includes(term))) continue;
    if (CONDIMENT_TERMS.some((term) => name.includes(term))) continue;
    if (["可乐", "饮料", "牛奶", "咖啡", "红茶", "果汁", "雪碧", "奶铁", "美式", "纯悦", "纯净水", "矿泉水"].some((term) => name.includes(term))) drinks.push(meal);
    else if (["薯条", "玉米", "小食", "鸡翅", "鸡块", "麦乐鸡"].some((term) => name.includes(term))) sides.push(meal);
    else if (MAIN_TERMS.some((term) => name.includes(term))) mains.push(meal);
  }
  return { mains, sides, drinks };
}

function validateMealPlan(items, preferences = {}) {
  const needed = ROLES.filter(role => !(preferences.omitRoles || []).includes(role));
  if (!Array.isArray(items) || items.length !== needed.length || !items.some((item, i) => (item.role || ROLES[i]) === 'main')) return { ok: false, reason: "餐品组成与要求不一致" };
  const types = items.map((item) => String(item?.name || ""));
  if (CONDIMENT_TERMS.some((term) => types[0].includes(term))) return { ok: false, reason: "酱料不能作为主食" };
  if (!MAIN_TERMS.some((term) => types[0].includes(term))) return { ok: false, reason: "主食没有通过餐品类型校验" };
  const drink = items.find((item, i) => (item.role || ROLES[i]) === 'drink');
  if (drink && !["可乐", "饮料", "牛奶", "咖啡", "红茶", "果汁", "雪碧", "奶铁", "美式", "纯悦", "纯净水", "矿泉水"].some(term => drink.name.includes(term))) return { ok: false, reason: "饮料没有通过餐品类型校验" };
  return { ok: true, harness: needed.length === 3 ? "meal-role-v1" : 'meal-role-explicit-omit-v2' };
}

function mealCombinations(meals, preferences = {}) {
  const { mains, sides, drinks } = mealCategories(meals, preferences);
  const pools = { main: mains, side: sides, drink: drinks };
  const activeRoles = ROLES.filter(role => !(preferences.omitRoles || []).includes(role));
  const matches = (meal, wanted) => {
    if (!wanted) return true;
    if (/无糖|不加糖|零糖/.test(wanted)) return /无糖|零度|纯悦|纯净水|矿泉水/.test(meal.name);
    return meal.name.includes(wanted.replace(/^(?:主食|配餐|饮料)(?:换成|换|要)?/, '').trim());
  };
  const choices = activeRoles.map(role => pools[role].filter(item => (!preferences.lockedItems?.[role] || String(item.code) === String(preferences.lockedItems[role]))
    && matches(item, preferences.preferredByRole?.[role])).slice(0, 30).map(item => ({ ...item, role })));
  const combinations = [];
  function combine(index, items) {
    if (index < choices.length) { for (const item of choices[index]) combine(index + 1, items.concat(item)); return; }
    const prices = items.map(mealPriceValue);
    if (items.length && prices.every(price => price !== null)) combinations.push({ items, total: Number(prices.reduce((sum, price) => sum + price, 0).toFixed(2)) });
  }
  combine(0, []);
  if (["light", "satisfying"].includes(preferences.mood)) combinations.sort((a, b) => moodScore(b, preferences) - moodScore(a, preferences) || a.total - b.total);
  return combinations;
}

function budgetValue(preferences) {
  const raw = preferences?.budgetMax !== null && preferences?.budgetMax !== undefined
    ? preferences.budgetMax
    : ({ light: 25, standard: 40 }[preferences?.budget]);
  const value = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(value) ? value : null;
}

function chooseMeals(meals, preferences = {}) {
  const combinations = mealCombinations(meals, preferences);
  if (combinations.length) {
    const budget = budgetValue(preferences);
    const eligible = budget === null ? combinations : combinations.filter((combo) => combo.total <= budget);
    if (budget === null) return combinations[0].items;
    if (!eligible.length) throw new Error(`preference_conflict: 没有不超过 ¥${budget.toFixed(2)} 的完整三件套`);
    eligible.sort((a, b) => Math.abs(budget - a.total) - Math.abs(budget - b.total) || a.total - b.total);
    return eligible[0].items;
  }
  throw new Error("preference_conflict: 当前门店没有可确认的主食、配餐、饮料完整三件套");
}

function alternativeCombinations(meals, selected, preferences = {}) {
  const selectedIds = new Set(selected.map((item) => String(item?.code || item?.name)));
  let combinations = mealCombinations(meals, preferences).filter((combo) => {
    const ids = new Set(combo.items.map((item) => String(item?.code || item?.name)));
    return [...ids].some((id) => !selectedIds.has(id));
  });
  const budget = budgetValue(preferences);
  if (budget !== null) {
    const eligible = combinations.filter((combo) => combo.total <= budget);
    combinations = eligible;
  }
  return combinations.sort((a, b) => moodScore(b, preferences) - moodScore(a, preferences) || a.total - b.total).slice(0, 6);
}

function bundleMeal(...items) {
  const names = items.map((item) => String(item?.displayName || item?.name || "未知餐品"));
  const totalValues = items.map(mealPriceValue);
  const total = totalValues.every((value) => value !== null) ? totalValues.reduce((sum, value) => sum + value, 0) : null;
  const bundleNutrition = summarizeNutrition(items);
  return {
    id: items.map((item) => String(item.code || item.name)).join("|"),
    name: `${names[0]}一人餐`,
    subtitle: names.join(" · "),
    items: items.map((item, index) => ({
      type: LABELS[item.role || ROLES[index]],
      role: item.role || ROLES[index],
      code: String(item?.code || ""),
      quantity: 1,
      name: names[index],
      supportModify: item.supportModify === true,
      price: mealPriceValue(item) !== null ? `¥${mealPriceValue(item).toFixed(2)}` : "暂无价格",
    })),
    nutrition: bundleNutrition,
    total: total === null ? "暂无" : total.toFixed(2),
    summary: `实时菜单 · ${total === null ? "价格待确认" : `¥${total.toFixed(2)}`}`,
    reason: `按本次要求搭配${names.join('、')}；以本次门店菜单价格汇总。`,
    dataStatus: "实时 MCP",
    updatedAt: "本次查询",
    priceSource: "麦当劳 MCP query-meals",
  };
}

function orderDraft(recommendation, store) {
  return {
    state: "confirmation_required",
    source: "recommendation",
    id: String(recommendation?.id || recommendation?.name || ""),
    store: {
      storeCode: String(store?.storeCode || ""),
      storeName: String(store?.storeName || ""),
      address: String(store?.address || ""),
    },
    items: Array.isArray(recommendation?.items) ? recommendation.items.map((item) => ({ ...item, quantity: 1 })) : [],
    total: recommendation?.total,
    nutrition: recommendation?.nutrition || {},
    priceSource: recommendation?.priceSource,
    payment: { state: "not_started", merchant: "麦当劳官方", message: "当前为菜单估价，下一步核对官方应付金额；尚未创建订单。" },
    confirmationRequired: true,
    writeToolsEnabled: false,
  };
}

async function liveRecommendation(ownerId, event) {
  const token = await selectStoredToken(ownerId);
  if (!token) return { ok: false, error: "MCP token is not linked" };
  const selectedBeType = Number(event?.beType) === 5 ? 5 : 1;
  const selectedStoreCode = typeof event?.storeCode === "string" ? event.storeCode.trim() : "";
  const selectedBeCode = typeof event?.beCode === "string" ? event.beCode.trim() : "";
  let store;
  if (selectedStoreCode) {
    store = normalizeStore({
      storeCode: selectedStoreCode,
      storeName: typeof event?.storeName === "string" ? event.storeName : "已选门店",
      address: typeof event?.storeAddress === "string" ? event.storeAddress : "",
      businessStatus: true,
      beCode: selectedBeCode,
    });
  } else {
    const label = typeof event?.locationLabel === "string" ? event.locationLabel : "";
    const parts = label.split(" · ").map((part) => part.trim()).filter(Boolean);
    const city = parts[0] && !parts[0].includes("通用") && !parts[0].includes("附近") ? parts[0] : "北京";
    const keyword = parts[1] || "望京";
    const stores = requireMcpSuccess(await mcpTool(token, "query-nearby-stores", { searchType: 2, city, keyword, beType: selectedBeType }), "query-nearby-stores");
    store = (Array.isArray(stores.data) ? stores.data : [])
      .map(normalizeStore)
      .filter((item) => item && item.businessStatus)
      .sort((a, b) => (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER))[0];
  }
  if (!store?.storeCode) throw new Error("MCP store data is incomplete");
  if (selectedBeType === 5 && !store.beCode) throw new Error("MCP drive-through store data is incomplete");
  const menuArgs = { storeCode: String(store.storeCode), orderType: 1, beType: selectedBeType };
  if (selectedBeType === 5) menuArgs.beCode = store.beCode;
  const menu = requireMcpSuccess(await mcpTool(token, "query-meals", menuArgs), "query-meals");
  const meals = asMeals(menu);
  const preferences = event?.preferences && typeof event.preferences === "object" ? event.preferences : {};
  const selected = chooseMeals(meals, preferences);
  const harness = validateMealPlan(selected, preferences);
  if (!harness.ok) throw new Error(`preference_conflict: ${harness.reason}`);
  const combos = [selected, ...alternativeCombinations(meals, selected, preferences).map(combo => combo.items)];
  let nutritionData = null, nutritionQueryFailed = false;
  const toolCalls = selectedStoreCode ? ["query-meals", "list-nutrition-foods"] : ["query-nearby-stores", "query-meals", "list-nutrition-foods"];
  try { nutritionData = requireMcpSuccess(await mcpTool(token, "list-nutrition-foods", {}), "list-nutrition-foods").data; }
  catch (_) { nutritionQueryFailed = true; }
  const resolved = await resolveNutrition(combos.flat(), nutritionData, async (code) => {
    toolCalls.push("query-meal-detail");
    const detailArgs = { ...menuArgs, code: String(code) };
    return requireMcpSuccess(await mcpTool(token, "query-meal-detail", detailArgs), "query-meal-detail").data;
  }, nutritionQueryFailed);
  const plans = combos.map(items => bundleMeal(...items.map(item => resolved.get(String(item.code || item.name)))));
  const recommendation = plans[0];
  const alternatives = plans.slice(1);
  return {
    ok: true,
    mode: "live_mcp",
    dataStatus: "实时 MCP",
    updatedAt: "本次查询",
    location: store.storeName,
    recommendation,
    alternatives,
    toolCalls,
    nutritionVersion: "detail-spec-v2",
    orderDraft: orderDraft(recommendation, store),
    harness: harness.harness,
    store: {
      storeCode: store.storeCode,
      storeName: store.storeName,
      address: store.address,
      distance: store.distance,
      businessStatus: store.businessStatus,
      beType: selectedBeType,
    },
  };
}

async function bind(ownerId, token) {
  const existing = await selectMetadata(ownerId);
  const valid = await validateMcpToken(token);
  if (!valid) {
    if (existing?.status === "active") {
      return { ok: false, status: "active", message: "new MCP token validation failed; existing binding retained" };
    }
    return { ok: false, status: "invalid", message: "MCP token validation failed" };
  }
  const timestamp = now();
  const encryptedToken = encryptToken(token);
  const models = dbModels();
  if (existing) {
    await models.$runSQL(
      `UPDATE \`${TABLE}\`
       SET encrypted_token = {{encryptedToken}}, status = 'active',
           bound_at = {{boundAt}}, last_validated_at = {{lastValidatedAt}},
           invalidated_at = NULL, disconnected_at = NULL, updated_at = {{updatedAt}}
       WHERE owner_id = {{ownerId}}`,
      { encryptedToken, boundAt: timestamp, lastValidatedAt: timestamp, updatedAt: timestamp, ownerId },
    );
  } else {
    await models.$runSQL(
      `INSERT INTO \`${TABLE}\`
       (_id, _openid, owner_id, encrypted_token, status, bound_at, last_validated_at, created_at, updated_at)
       VALUES ({{id}}, {{openid}}, {{ownerId}}, {{encryptedToken}}, 'active', {{boundAt}}, {{lastValidatedAt}}, {{createdAt}}, {{updatedAt}})`,
      { id: ownerId, openid: ownerId, ownerId, encryptedToken, boundAt: timestamp, lastValidatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
    );
  }
  return { ok: true, status: "active", lastValidatedAt: timestamp };
}

async function updateStatus(ownerId, status) {
  const timestamp = now();
  const invalidatedAt = status === "invalid" ? timestamp : null;
  const disconnectedAt = status === "disconnected" ? timestamp : null;
  await dbModels().$runSQL(
    `UPDATE \`${TABLE}\`
     SET status = {{status}}, encrypted_token = '', updated_at = {{updatedAt}},
         invalidated_at = {{invalidatedAt}}, disconnected_at = {{disconnectedAt}}
     WHERE owner_id = {{ownerId}}`,
    { status, updatedAt: timestamp, invalidatedAt, disconnectedAt, ownerId },
  );
  return { ok: true, status };
}

async function main(event, context) {
  const ownerId = ownerIdFromContext(event, context);
  const action = typeof event?.action === "string" ? event.action : "status";
  if (action === "status") return { ok: true, metadata: await selectMetadata(ownerId) };
  if (action === "provider-status") return providerStatus(ownerId);
  if (action === "provider-save") return saveProviderConfig(ownerId, event);
  if (action === "bind") return bind(ownerId, event?.token);
  if (action === "stores") return nearbyStores(ownerId, event);
  if (action === "agent") return agent(ownerId, event);
  if (action === 'order-access') {
    const access = orderAccessService();
    return { ok: true, gate: await access.read(ownerId), accountFingerprint: access.fingerprint(ownerId) };
  }
  if (action === 'order-readiness') {
    const token = await selectStoredToken(ownerId);
    if (!token) throw stateError('token_required', '请先链接麦当劳账号');
    const list = requireMcpSuccess(await mcpTool(token, 'order-list', {}), 'order-list').data?.list;
    if (!Array.isArray(list)) throw stateError('order_check_unavailable', '暂时无法核对官方订单接口');
    return { ok: true, orderQueryAvailable: true, gate: await orderAccessService().read(ownerId) };
  }
  const checkoutActions = { 'checkout-quote': 'quote', 'checkout-get': 'get', 'checkout-prepare': 'prepare', 'checkout-create': 'create',
    'orders-list': 'list', 'order-refresh': 'refresh', 'order-reconcile': 'reconcile', 'order-payment': 'payment', 'order-cancel-prepare': 'prepareCancel', 'order-cancel': 'cancel' };
  if (checkoutActions[action]) return checkoutService()[checkoutActions[action]](ownerId, event);
  if (action === 'conversation-get') return conversationService().restore(ownerId, event.conversationId);
  if (action === 'conversation-select') return conversationService().select(ownerId, event);
  if (action === 'conversation-clear') { await stateStore().remove(ownerId, 'conversation', event.conversationId); return { ok: true }; }
  if (action === 'preferences-get') return { ok: true, preferences: await createPreferenceService({ store: stateStore() }).read(ownerId) };
  if (action === 'preferences-save') return { ok: true, preferences: await createPreferenceService({ store: stateStore() }).save(ownerId, event) };
  if (action === 'preferences-disable') return { ok: true, preferences: await createPreferenceService({ store: stateStore() }).disable(ownerId, event.revision) };
  if (action === 'preferences-delete') return { ok: true, preferences: await createPreferenceService({ store: stateStore() }).remove(ownerId, event.confirmed) };
  if (action === "recommend") {
    try {
      return await liveRecommendation(ownerId, event);
    } catch (error) {
      if (String(error?.message || "").startsWith("preference_conflict:")) {
        return {
          ok: true,
          mode: "constraint_conflict",
          state: "clarifying",
          question: "当前门店没有同时满足这些条件的完整一人餐。要放宽哪一项？",
          reason: String(error.message).split(":").slice(1).join(":").trim(),
        };
      }
      throw error;
    }
  }
  if (action === "disconnect") return updateStatus(ownerId, "disconnected");
  if (action === "invalidate") return updateStatus(ownerId, "invalid");
  if (action === "delete") {
    await dbModels().$runSQL(
      `DELETE FROM \`${TABLE}\` WHERE owner_id = {{ownerId}}`,
      { ownerId },
    );
    return { ok: true, status: "deleted" };
  }
  fail("unsupported token action");
}

exports.main = async (event, context) => {
  try {
    return await main(event, context);
  } catch (error) {
    // Never return error objects, event data, context, headers, or env values.
    if (error && error.safe) return { ok: false, code: error.code || 'operation_failed', error: error.message };
    const frames = String(error?.stack || '').split('\n').slice(1).map(line => line.match(/[a-zA-Z0-9_-]+\.js:\d+:\d+/)?.[0]).filter(Boolean).slice(0, 4);
    const message = String(error?.message || '');
    const diagnostic = { event: 'operation_failed', errorType: ['TypeError', 'SyntaxError', 'RangeError'].includes(error?.name) ? error.name : 'Error', frames,
      databaseError: /SQL|database|column|statement/i.test(message), syntaxError: /syntax/i.test(message), parameterError: /parameter|params|placeholder/i.test(message),
      code: /^[A-Z_0-9]{1,60}$/.test(String(error?.code || '')) ? error.code : null,
      reference: message.match(/Cannot read (?:properties|property) of (?:undefined|null) \(reading '[a-zA-Z_]+?'\)/)?.[0] || null };
    console.warn(JSON.stringify(diagnostic));
    return { ok: false, error: "服务暂时不可用，请稍后重试" };
  }
};
