-- ---------------------------------------------------------------------------
--  2026-09-18  点歌前置：注意事项确认 + 播出时段可选化
--
--  适用：已经在跑的库（sql/schema.sql 只在 MySQL 数据卷首次初始化时执行）
--  执行：
--    docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-notice-slot.sql
--
--  幂等性：建表用 IF NOT EXISTS，设置项用 ON DUPLICATE KEY。
-- ---------------------------------------------------------------------------

-- 1) 注意事项确认记录
--    每人每份注意事项一行；version 记的是「确认时那份内容的版本号」，
--    管理员改内容 → 版本 +1 → 所有人 needAck 重新变 true。
CREATE TABLE IF NOT EXISTS `notice_ack` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`      VARCHAR(64)     NOT NULL COMMENT '确认人',
  `notice_key`  VARCHAR(32)     NOT NULL COMMENT '注意事项标识，如 song_submit',
  `version`     INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '确认时的内容版本号',
  `create_time` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_openid_notice` (`openid`, `notice_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='注意事项确认记录';

-- 2) 注意事项正文与版本号（KV）
--    正文也可以留空不建：服务端读不到正文就认为「未配置」→ 用户端不弹窗、不拦提交。
INSERT INTO `system_setting` (`key`, `value`, `desc`) VALUES
  ('song_notice',         '', '点歌注意事项正文（留空 = 不启用）'),
  ('song_notice_version', '0', '点歌注意事项版本号（内容变化时 +1，用于强制重新确认）')
ON DUPLICATE KEY UPDATE `key` = `key`;

-- 3) 播出时段依赖的设置项（如果还没有的话）
--    系统会从 broadcast_schedule 里解析出 HH:mm 列表，当作每天的可选时段；
--    解析不出来时退回默认的 07:20 / 12:20 / 17:30，所以这条不建也能跑。
INSERT INTO `system_setting` (`key`, `value`, `desc`) VALUES
  ('broadcast_schedule', '07:20 / 12:20 / 17:30', '每日开播时段（点歌可选时段由此派生）')
ON DUPLICATE KEY UPDATE `key` = `key`;


-- ---------------------------------------------------------------------------
--  说明：播出时段本身**不需要建表**。
--  可选范围 = 下一周的周一到周五（计算得出）× broadcast_schedule 里的时段，
--  用户选中的值以「2026-09-21 午间 12:20」这样的规范字符串存进
--  submit.want_broadcast_time（沿用原有字段，无需改表）。
--
--  想看成哪些值合法，可以跑（把日期换成你要查的那一周）：
--  SELECT DATE_ADD(CURDATE(), INTERVAL (8 - WEEKDAY(CURDATE())) DAY) AS next_monday;
--  周一 = 上面这个日期，周五 = 周一 + 4 天。
-- ---------------------------------------------------------------------------
