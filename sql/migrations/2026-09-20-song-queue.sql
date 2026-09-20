-- =====================================================================
-- 点歌规则 v2：排期容量池 + 全局候补队列 + 点歌时间窗口
-- 迁移日期：2026-09-20
-- 设计文档：docs/song-queue-v2.md（v2.4）
--
-- 已有库必须手动跑这一份（sql/schema.sql 只在数据卷首启时执行）。
-- 参考执行方式：
--   docker exec -i <mysql容器> mysql -uroot -p<密码> <库名> < sql/migrations/2026-09-20-song-queue.sql
--
-- 内容：
--   ① submit 加 3 个字段：scheduled_slot / queue_at / promoted_at
--   ② submit 加 2 个索引：idx_sched_status / idx_queue
--   ③ status / auto_rejected 注释更新为 v2 语义（3=候补中 4=已补位待审）
--   ④ 存量回填：已占位的点歌，实际排期 = 学生首选时段
--   ⑤ 日/周名额计数器退役：清空 song_quota
--
-- ⚠️ 本文件不是幂等的：重复执行会报 1060 Duplicate column name /
--    1061 Duplicate key name，看到这两个错直接忽略即可（说明已经跑过）。
-- ⚠️ 第 ⑤ 步 TRUNCATE 会清掉历史计数行 —— 那本账在 v2 里已经作废，清了才不会再被误读。
-- =====================================================================

-- ① 新字段
ALTER TABLE `submit`
  ADD COLUMN `scheduled_slot` VARCHAR(64) DEFAULT NULL COMMENT '实际排期时段（候补补位后可能与学生首选不同）',
  ADD COLUMN `queue_at`       DATETIME    DEFAULT NULL COMMENT '进入候补队列时刻（FIFO 排序键，同刻用 id 兜底）',
  ADD COLUMN `promoted_at`    DATETIME    DEFAULT NULL COMMENT '递补为占位状态的时刻（复盘用）';

-- ② 新索引
--    idx_sched_status：每格容量统计 / 排期矩阵都按 scheduled_slot + status 查
--    idx_queue：候补队列按 status + queue_at 取队首、算位次
ALTER TABLE `submit`
  ADD KEY `idx_sched_status` (`scheduled_slot`, `status`),
  ADD KEY `idx_queue`        (`status`, `queue_at`, `id`);

-- ③ 注释更新到 v2 语义
ALTER TABLE `submit`
  MODIFY COLUMN `status` TINYINT NOT NULL DEFAULT 0
    COMMENT '0=待审 1=已排期 2=已驳回 3=候补中 4=已补位待审',
  MODIFY COLUMN `auto_rejected` TINYINT NOT NULL DEFAULT 0
    COMMENT '1=系统自动驳回（满额/逾期），0=人工处理';

-- ④ 存量回填：v1 里 status ∈ {0,1} 的点歌当初就是按 want_broadcast_time 占位的
UPDATE `submit`
   SET `scheduled_slot` = `want_broadcast_time`
 WHERE `type` = 1 AND `status` IN (0, 1) AND `scheduled_slot` IS NULL;

-- ⑤ 日/周名额计数器退役（代码层已不再读写；留表一个版本，v2.x 再 DROP TABLE）
TRUNCATE TABLE `song_quota`;
DELETE FROM `system_setting` WHERE `key` IN ('song_quota_daily', 'song_quota_weekly');

-- =====================================================================
-- 上线后需要人工确认的 KV（管理端也可改）：
--   song_slot_capacity  = 每格正式位（建议 1）
--   song_queue_limit    = 0 或留空 → 自动等于下周正式位总数
--   song_submit_window  = {"enabled":1,"startDay":6,"startTime":"18:00","endDay":0,"endTime":"18:00"}
--                         不想马上限制投稿时间就先把 enabled 设成 0
-- =====================================================================
