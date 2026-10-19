-- Per-user Provider configuration. API keys are always stored as ciphertext
-- produced by the cloud function; this table never receives plaintext keys.
ALTER TABLE `mcd_mcp_tokens`
  ADD COLUMN `provider` VARCHAR(64) NULL,
  ADD COLUMN `provider_model` VARCHAR(128) NULL,
  ADD COLUMN `provider_base_url` VARCHAR(512) NULL,
  ADD COLUMN `encrypted_provider_key` TEXT NULL,
  ADD COLUMN `provider_updated_at` DATETIME(3) NULL;
