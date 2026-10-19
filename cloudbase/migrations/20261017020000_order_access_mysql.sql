-- Administrator-only test access. This table contains no token or raw user identity.
CREATE TABLE IF NOT EXISTS `maimai_order_access` (
  `_id` CHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  `owner_hash` CHAR(64) NOT NULL,
  `enabled` TINYINT NOT NULL DEFAULT 0,
  `max_total_cents` INT NOT NULL DEFAULT 10000,
  `expires_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`_id`),
  UNIQUE KEY `order_access_owner` (`owner_hash`)
);
