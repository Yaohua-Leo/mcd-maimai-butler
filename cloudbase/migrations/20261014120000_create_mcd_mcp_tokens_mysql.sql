-- G1-MVP MySQL schema for the personal CloudBase environment.
-- Plaintext MCD_MCP_TOKEN values must never be written to this table.
CREATE TABLE IF NOT EXISTS `mcd_mcp_tokens` (
  `_id`                 VARCHAR(128) NOT NULL,
  `_openid`             VARCHAR(128) NULL,
  `owner_id`            VARCHAR(128) NOT NULL,
  `encrypted_token`     TEXT NOT NULL,
  `status`              VARCHAR(32) NOT NULL DEFAULT 'active',
  `bound_at`            DATETIME(3) NOT NULL,
  `last_validated_at`   DATETIME(3) NULL,
  `invalidated_at`      DATETIME(3) NULL,
  `disconnected_at`     DATETIME(3) NULL,
  `created_at`          DATETIME(3) NOT NULL,
  `updated_at`          DATETIME(3) NOT NULL,
  PRIMARY KEY (`owner_id`),
  UNIQUE KEY `mcd_mcp_tokens_id_uq` (`_id`),
  CONSTRAINT `mcd_mcp_tokens_status_chk`
    CHECK (`status` IN ('active', 'invalid', 'disconnected'))
);
