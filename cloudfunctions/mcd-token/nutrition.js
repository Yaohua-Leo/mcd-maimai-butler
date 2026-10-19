"use strict";

const FIELDS = ["energyKcal", "protein", "sodium"];
const SOURCE = "麦当劳 MCP list-nutrition-foods；按餐品详情规格匹配";

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedName(value) {
  // Formatting only: retain portion, count, temperature and flavour distinctions.
  let name = String(value || "").replace(/[™®]/g, "").normalize("NFKC").replace(/[\s()（）]/g, "").toLowerCase();
  // Observed MCP detail/catalog naming conventions, never fuzzy food matching.
  name = name.replace(/^麦咖啡/, "")
    .replace(/^(\d+)块(麦乐鸡|麦辣鸡翅)$/, "$2$1块")
    .replace(/^(麦乐鸡|麦辣鸡翅)-(\d+)块$/, "$1$2块")
    .replace(/^(小|中|大|迷你)薯条$/, "薯条$1");
  const cups = name.match(/[小中大]杯/g) || [];
  if (cups.length === 1) name = `${name.replace(cups[0], "")}#${cups[0]}`;
  return name;
}

function csvFields(line) {
  const fields = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { fields.push(field.trim()); field = ""; }
    else field += ch;
  }
  fields.push(field.trim());
  return fields;
}

function nutritionRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return nutritionRows(value.data);
  if (typeof value !== "string") return [];
  const header = value.match(/\{([^}]+)\}/);
  if (!header) return [];
  const headers = csvFields(header[1]);
  return value.split(/\r?\n/).filter(line => !line.trim().startsWith("[") && line.includes(","))
    .map(csvFields).filter(fields => fields.length === headers.length)
    .map(fields => Object.fromEntries(headers.map((key, i) => [key, fields[i]])));
}

function createIndex(raw) {
  const index = new Map();
  for (const row of nutritionRows(raw)) {
    const name = row.productName || row.name;
    const key = normalizedName(name);
    if (!key) continue;
    const entry = { matchedName: name, ...Object.fromEntries(FIELDS.map(field => [field, numberOrNull(row[field])])) };
    if (index.has(key) && FIELDS.some(field => index.get(key)?.[field] !== entry[field])) {
      index.set(key, null); // Conflicting official rows must not be silently overwritten.
    } else if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

function missing(reason, status = "unmatched") {
  return { ...Object.fromEntries(FIELDS.map(field => [field, null])), matchedName: "", status, reason };
}

function match(index, name) {
  const entry = index.get(normalizedName(name));
  return entry ? { ...entry, status: "matched", reason: "" } : null;
}

function fromDetail(index, item, detail) {
  const displayName = String(detail?.name || item.name);
  const direct = match(index, displayName);
  if (direct) return { ...item, displayName, supportModify: detail.supportModify === true, nutritionEntry: direct };
  const rounds = Array.isArray(detail?.rounds) ? detail.rounds : [];
  const defaults = rounds.map(round => (round.choices || []).filter(choice => Number(choice.isDefault) === 1));
  if (rounds.length && defaults.every(choices => choices.length)) {
    const choices = defaults.flat();
    const matches = choices.map(choice => match(index, choice.name));
    if (matches.every(Boolean)) {
      const entry = { status: "matched", reason: "", matchedName: choices.map(choice => choice.name).join(" + ") };
      for (const field of FIELDS) {
        const quantities = choices.map(choice => choice.quantity === undefined ? 1 : numberOrNull(choice.quantity));
        entry[field] = matches.every((row, i) => row[field] !== null && quantities[i] !== null && quantities[i] > 0)
          ? Number(matches.reduce((sum, row, i) => sum + row[field] * quantities[i], 0).toFixed(2)) : null;
      }
      return { ...item, displayName: `${displayName}（${entry.matchedName}）`, supportModify: detail.supportModify === true, nutritionEntry: entry };
    }
  }
  return { ...item, displayName, supportModify: detail?.supportModify === true,
    nutritionEntry: missing(rounds.length ? "默认规格未能完整匹配官方营养表" : "官方营养表未找到此规格") };
}

async function resolveNutrition(items, raw, loadDetail, queryFailed = false) {
  const index = createIndex(raw);
  const unique = [...new Map(items.map(item => [String(item.code || item.name), item])).values()];
  const result = new Map();
  let cursor = 0;
  // Deduplicate across main and alternative plans; cap concurrent MCP detail calls.
  async function worker() {
    while (cursor < unique.length) {
      const item = unique[cursor++];
      const key = String(item.code || item.name);
      const direct = match(index, item.name);
      if (direct) result.set(key, { ...item, displayName: item.name, nutritionEntry: direct });
      else if (queryFailed || !index.size) result.set(key, { ...item, displayName: item.name,
        nutritionEntry: missing(queryFailed ? "营养接口查询失败，请稍后重试" : "营养表为空或格式无法识别", "unavailable") });
      else {
        try {
          const detail = await loadDetail(item.code);
          if (!detail || String(detail.code) !== String(item.code)) throw new Error("detail mismatch");
          result.set(key, fromDetail(index, item, detail));
        } catch (_) {
          result.set(key, { ...item, displayName: item.name, nutritionEntry: missing("餐品规格查询失败，无法确认份量", "detail_failed") });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker));
  return result;
}

function summarizeNutrition(items) {
  const details = items.map(item => ({ name: item.displayName || item.name, ...(item.nutritionEntry || missing("尚未查询此餐品")) }));
  const result = { source: SOURCE, items: details, matchedItems: details.filter(item => item.status === "matched").length, itemCount: items.length };
  for (const field of FIELDS) {
    result[field] = details.length && details.every(item => typeof item[field] === "number")
      ? Number(details.reduce((sum, item) => sum + item[field], 0).toFixed(2)) : "暂无";
  }
  result.status = FIELDS.every(field => typeof result[field] === "number") ? "complete" : "partial";
  result.missingItems = details.filter(item => FIELDS.some(field => item[field] === null))
    .map(item => ({ name: item.name, reason: item.reason || "官方营养表缺少部分字段" }));
  result.coverage = `已匹配 ${result.matchedItems}/${result.itemCount} 项`;
  result.note = result.status === "complete" ? "按所列规格汇总" : "整餐总量不完整；已知单品数值见下方，缺失项不按 0 计算。";
  return result;
}

module.exports = { numberOrNull, normalizedName, nutritionRows, createIndex, resolveNutrition, summarizeNutrition };
