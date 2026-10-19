-- G1-MVP: one encrypted MCP token binding per CloudBase user.
-- The encrypted_token value is produced by the backend only. Plaintext MCP
-- tokens must never be written to this table, logs, prompts, or exports.
CREATE TABLE mcd_mcp_tokens (
  owner_id            TEXT PRIMARY KEY,
  encrypted_token     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalid', 'disconnected')),
  bound_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_validated_at   TIMESTAMPTZ,
  invalidated_at      TIMESTAMPTZ,
  disconnected_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This table is accessed by a trusted backend boundary, not directly by the
-- mini program. RLS remains enabled as a fail-closed default.
ALTER TABLE mcd_mcp_tokens ENABLE ROW LEVEL SECURITY;

-- Rollback (manual, only if the table is confirmed disposable):
-- DROP TABLE IF EXISTS mcd_mcp_tokens;
