-- ═══════════════════════════════════════════════════════════════════════════
-- 学生账号体系（导入分发 + 账号密码登录）· 迁移脚本
--   日期：2026-09-18
--   适用：**已有数据的库**（新建库直接跑 schema.sql 即可）
--
--   执行方式（Docker）：
--     docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-student-account.sql
--
--   幂等性：本脚本**不是**完全幂等（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS），
--           重复执行会在「已存在」的列上报 1060 错误。看到 1060 = 已经跑过了，可忽略。
--   ⚠️ 执行前请先备份：docker exec radio-mysql mysqldump ... > backup.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. user 表扩展 ────────────────────────────────────────────────────────
-- 说明：账号体系复用 user 表，而不是新建身份表。
--       原因：submit / message / notice_ack / song_quota 全部按 openid 字段关联，
--       扩表可以让这些存量逻辑一行都不用改（登录时 JWT 的 openid 字段填账号本身）。

-- 1.1 openid 必须允许 NULL（学生账号没有微信 openid）
--     MySQL 的 UNIQUE 允许多行 NULL，所以原有唯一约束保留即可。
ALTER TABLE `user` MODIFY COLUMN `openid` VARCHAR(64) NULL COMMENT '微信OpenID（账号体系下为空）';

-- 1.2 账号与密码
ALTER TABLE `user`
  ADD COLUMN `username`   VARCHAR(32)  NULL COMMENT '登录账号=入学年级+班级+序号，如 20240101' AFTER `openid`,
  ADD COLUMN `password`   VARCHAR(72)  NULL COMMENT 'bcrypt 哈希；老微信用户为空' AFTER `username`;

-- 1.3 名册三元组 + 状态
ALTER TABLE `user`
  ADD COLUMN `grade`           VARCHAR(8)  NULL COMMENT '入学年级，如 2024' AFTER `password`,
  ADD COLUMN `class_no`        VARCHAR(4)  NULL COMMENT '班级，如 01'       AFTER `grade`,
  ADD COLUMN `seat_no`         VARCHAR(4)  NULL COMMENT '序号，如 01'       AFTER `class_no`,
  ADD COLUMN `remark`          VARCHAR(64) NULL COMMENT '备注（可存姓名）'  AFTER `seat_no`,
  ADD COLUMN `status`          TINYINT     NOT NULL DEFAULT 1 COMMENT '1=启用 0=禁用' AFTER `remark`,
  ADD COLUMN `pwd_changed_at`  DATETIME    NULL COMMENT '为空=仍是初始密码 user+学号' AFTER `status`,
  ADD COLUMN `last_login_at`   DATETIME    NULL COMMENT '最近登录时间' AFTER `pwd_changed_at`,
  ADD COLUMN `login_count`     INT         NOT NULL DEFAULT 0 COMMENT '累计登录次数' AFTER `last_login_at`,
  ADD COLUMN `import_batch_id` INT         NULL COMMENT '来源导入批次' AFTER `login_count`;

-- 1.4 索引
-- uk_username：登录查询；NULL 可以有多行（老微信用户），互不冲突
ALTER TABLE `user` ADD UNIQUE KEY `uk_username` (`username`);
-- uk_grade_class_seat：从根上防住「同一个人被导入两次」
ALTER TABLE `user` ADD UNIQUE KEY `uk_grade_class_seat` (`grade`, `class_no`, `seat_no`);
-- 列表按年级 / 班级筛选
ALTER TABLE `user` ADD KEY `idx_grade_class` (`grade`, `class_no`);

-- ── 2. import_batch 导入批次表 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `import_batch` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `filename`    VARCHAR(255) NOT NULL DEFAULT '' COMMENT '上传的原始文件名',
  `total`       INT          NOT NULL DEFAULT 0 COMMENT '表格总数据行数',
  `created`     INT          NOT NULL DEFAULT 0 COMMENT '新建账号数',
  `updated`     INT          NOT NULL DEFAULT 0 COMMENT '覆盖更新数（未激活的既有账号）',
  `skipped`     INT          NOT NULL DEFAULT 0 COMMENT '跳过数（已激活，受保护）',
  `invalid`     INT          NOT NULL DEFAULT 0 COMMENT '异常行数',
  `operator_id` INT          NULL COMMENT '操作管理员 id',
  `operator`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作管理员用户名',
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_create_time` (`create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生名册导入批次';

-- ── 3. 系统开关 ───────────────────────────────────────────────────────────
-- 默认 on：小程序必须用账号密码登录（关掉即恢复微信登录，用于回退）
-- ⚠️ desc 用 UNHEX 写死「强制学号登录」的 UTF-8 字节：
--    应用脚本常经控制台管道，中文会被按 GBK 重编码（2026-09-19 实际踩过，页面显示乱码）。
--    请尽量用 mysql --default-character-set=utf8mb4 应用本文件。
INSERT IGNORE INTO `system_switch` (`key`, `value`, `desc`)
VALUES ('account_login_required', 'on',
        CONVERT(UNHEX('E5BCBAE588B6E5ADA6E58FB7E799BBE5BD95') USING utf8mb4));

-- ── 4. 执行后自检 ─────────────────────────────────────────────────────────
-- 4.1 列是否齐（应返回 10 行）
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA='radio_station' AND TABLE_NAME='user'
--      AND COLUMN_NAME IN ('openid','username','password','grade','class_no','seat_no',
--                          'remark','status','pwd_changed_at','last_login_at','login_count','import_batch_id');
-- 4.2 索引是否齐（应看到 uk_username / uk_grade_class_seat / idx_grade_class）
--   SHOW INDEX FROM `user`;
-- 4.3 表是否建好
--   SHOW CREATE TABLE `import_batch`;
-- 4.4 开关是否写入
--   SELECT * FROM `system_switch` WHERE `key`='account_login_required';

-- ── 5. 回滚（谨慎，会丢账号数据）──────────────────────────────────────────
--   ALTER TABLE `user` DROP INDEX `uk_username`;
--   ALTER TABLE `user` DROP INDEX `uk_grade_class_seat`;
--   ALTER TABLE `user` DROP INDEX `idx_grade_class`;
--   ALTER TABLE `user`
--     DROP COLUMN `username`, DROP COLUMN `password`, DROP COLUMN `grade`,
--     DROP COLUMN `class_no`, DROP COLUMN `seat_no`, DROP COLUMN `remark`,
--     DROP COLUMN `status`, DROP COLUMN `pwd_changed_at`, DROP COLUMN `last_login_at`,
--     DROP COLUMN `login_count`, DROP COLUMN `import_batch_id`;
--   DROP TABLE `import_batch`;
--   DELETE FROM `system_switch` WHERE `key`='account_login_required';
--   -- 老微信用户恢复 NOT NULL 前需先补空值，否则会失败：
--   -- UPDATE `user` SET `openid` = CONCAT('legacy_', id) WHERE `openid` IS NULL;
--   -- ALTER TABLE `user` MODIFY COLUMN `openid` VARCHAR(64) NOT NULL;
