-- ---------------------------------------------------------------------------
--  2026-09-18  点歌名额（每日 / 每周上限 + 超额自动驳回）
--
--  适用：已经在跑的库（sql/schema.sql 只在 MySQL 数据卷首次初始化时执行，
--        改 schema.sql 对已有库不生效，所以这里单独给一份增量脚本）
--
--  执行：
--    docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-quota.sql
--
--  幂等性：ADD COLUMN / ADD KEY 重复执行会报 Duplicate 错误，可忽略；
--          建表用了 IF NOT EXISTS，设置项用了 ON DUPLICATE KEY。
-- ---------------------------------------------------------------------------

-- 1) submit 增加「系统自动驳回」标记 + 自动驳回要用的复合索引
--    索引顺序有讲究：type(区分点歌) → status(只扫待审) → create_time(卡时间区间)
ALTER TABLE `submit`
  ADD COLUMN `auto_rejected` TINYINT NOT NULL DEFAULT 0
    COMMENT '1=由系统自动驳回（点歌名额已满），0=人工处理' AFTER `review_time`,
  ADD KEY `idx_type_status_create` (`type`, `status`, `create_time`);

-- 2) 名额计数器：一个周期一行，靠唯一键保证并发首建只成功一次
--    并发要点见 src/services/songQuotaService.js 顶部注释
CREATE TABLE IF NOT EXISTS `song_quota` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `period`        TINYINT         NOT NULL COMMENT '1=日 2=周',
  `period_key`    VARCHAR(10)     NOT NULL COMMENT '日=2026-09-18；周=2026-W38（ISO 周，周一起）',
  `used`          INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '本周期已通过的点歌数，原子自增',
  `exhausted_at`  DATETIME        DEFAULT NULL COMMENT '名额用尽时刻，仅用于展示与排查',
  `create_time`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_period_key` (`period`, `period_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点歌名额计数器（日/周各一行）';

-- 3) 名额上限的配置项（KV，0 或空 = 不限制）
--    也可以不执行这两条：后台「点歌审核」页保存名额时会自动 upsert；
--    读不到设置时服务端按「不限制」处理（fail-open）。
INSERT INTO `system_setting` (`key`, `value`, `desc`) VALUES
  ('song_quota_daily',  '0', '点歌名额上限：每日（0=不限制）'),
  ('song_quota_weekly', '0', '点歌名额上限：每周（0=不限制）')
ON DUPLICATE KEY UPDATE `key` = `key`;


-- ---------------------------------------------------------------------------
--  对账（怀疑计数器漂移时手动跑，正常不需要）
--
--  计数器是「名额判定」的唯一依据；下面这个查询用来核对它与真实数据是否一致。
--  会漂移的只有一种操作：手工在库里删掉已通过的点歌（走接口删除会自动归还名额）。
--
--  SELECT q.period_key, q.used AS counter,
--         (SELECT COUNT(*) FROM submit s
--           WHERE s.type=1 AND s.status=1
--             AND s.create_time >= '2026-09-18 00:00:00'
--             AND s.create_time <  '2026-09-19 00:00:00') AS real_approved
--    FROM song_quota q
--   WHERE q.period=1 AND q.period_key='2026-09-18';
--
--  不一致时以真实数据为准修回（先确认没有正在进行的审核）：
--  UPDATE song_quota SET used = <real_approved>
--   WHERE period=1 AND period_key='2026-09-18';
-- ---------------------------------------------------------------------------
