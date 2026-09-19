-- ============================================================
-- 2026-09-19 · 整届清理回执表（v8「清理完成」屏）
-- ------------------------------------------------------------
-- 背景：「清理完成」屏要回答三个问题 —— 删了几个、留了几个、怎么找回。
--       执行结果必须留档，才能显示回执、导出回执、事后追责。
-- 影响：新增表，不动任何既有表 / 数据。
-- 执行：
--   docker exec -i radio-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
--     < sql/migrations/2026-09-19-cleanup-log.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS `cleanup_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `grade` VARCHAR(8) NOT NULL COMMENT '年级（4 位入学年，如 2024）',
  `grade_name` VARCHAR(16) DEFAULT NULL COMMENT '如「2024 级」',
  `mode` VARCHAR(10) NOT NULL COMMENT 'safe / disable / purge',
  `total` INT UNSIGNED DEFAULT 0 COMMENT '该届账号总数',
  `deleted` INT UNSIGNED DEFAULT 0 COMMENT '真正删除数',
  `disabled` INT UNSIGNED DEFAULT 0 COMMENT '改为停用数',
  `class_count` INT UNSIGNED DEFAULT 0 COMMENT '涉及班级数',
  `untouched` INT UNSIGNED DEFAULT 0 COMMENT '其余届未受影响的账号数',
  `cost_ms` INT UNSIGNED DEFAULT 0 COMMENT '执行耗时（毫秒）',
  `operator_id` INT UNSIGNED DEFAULT NULL COMMENT '执行人管理员 id',
  `operator_name` VARCHAR(64) DEFAULT NULL COMMENT '执行人显示名',
  `disabled_accounts` TEXT COMMENT 'JSON 数组：[{username,name,className}]',
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_grade_time` (`grade`, `create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='整届清理（毕业清理）回执';
