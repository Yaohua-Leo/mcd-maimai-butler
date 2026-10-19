-- Private application state. encrypted_payload contains no plaintext credentials.
-- Client table access must be disabled; access only through authenticated functions.
CREATE TABLE IF NOT EXISTS `maimai_agent_state` (
  `_id` VARCHAR(128) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL,
  `kind` VARCHAR(24) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT 1,
  `write_id` VARCHAR(64) NOT NULL,
  `encrypted_payload` MEDIUMTEXT NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`_id`),
  KEY `maimai_state_owner_kind` (`owner_id`, `kind`, `updated_at`),
  KEY `maimai_state_expiry` (`expires_at`)
);
