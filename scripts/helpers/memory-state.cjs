const { stateError } = require('../../cloudfunctions/mcd-token/state-store');
function memoryState(clock = () => Date.now()) {
  const values = new Map(); let counter = 0;
  const key = (owner, kind, id) => `${owner}:${kind}:${id}`;
  const clone = x => x == null ? x : structuredClone(x);
  async function get(owner, kind, id) {
    const row = values.get(key(owner, kind, id));
    return row && (!row.expiresAt || row.expiresAt > clock()) ? clone(row) : null;
  }
  async function create(owner, kind, value, options = {}) {
    const id = options.id || `${kind}_${++counter}`, k = key(owner, kind, id);
    const stored = values.get(k);
    const existing = stored && (!stored.expiresAt || stored.expiresAt > clock()) ? clone(stored) : null;
    if (existing && options.once) return { ...existing, created: false };
    if (existing) throw Error('duplicate');
    const row = { id, kind, revision: 1, expiresAt: options.ttlMs ? clock() + options.ttlMs : null, value: clone(value), created: true };
    values.set(k, row); return clone(row);
  }
  async function replace(owner, kind, id, revision, value, ttlMs) {
    const row = values.get(key(owner, kind, id));
    if (!row || row.revision !== revision) throw stateError('version_conflict', '版本冲突');
    const next = { ...row, value: clone(value), revision: revision + 1, expiresAt: ttlMs ? clock() + ttlMs : null };
    values.set(key(owner, kind, id), next); return clone(next);
  }
  return { get, create, replace, values,
    async remove(owner, kind, id) { values.delete(key(owner, kind, id)); },
    async clearKind(owner, kind) { for (const k of values.keys()) if (k.startsWith(`${owner}:${kind}:`)) values.delete(k); },
    async list(owner, kind, limit = 20) { return [...values.keys()].filter(k => k.startsWith(`${owner}:${kind}:`)).map(k => clone(values.get(k))).filter(r => !r.expiresAt || r.expiresAt > clock()).slice(0, limit); }
  };
}
module.exports = { memoryState };
