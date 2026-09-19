-- ---------------------------------------------------------------------------
--  2026-09-18  点歌规则扩展：文稿注意事项 + 可发布时段 + 提交规则
--              （承接同日的 song-notice-slot.sql，可单独执行，幂等）
--
--  执行：
--    docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-rules.sql
--
--  说明：本文件只加 KV 设置项，**不建表、不改表**。
--        读不到这些键时服务端都有默认值（见各 service 顶部注释），
--        所以这条脚本「不执行也能跑」，执行只是把默认值显式落到库里方便查看/手改。
-- ---------------------------------------------------------------------------

INSERT INTO `system_setting` (`key`, `value`, `desc`) VALUES
  -- 文稿也有一份自己的注意事项（与点歌那份完全独立，各自版本号）
  ('article_notice',          '', '文稿注意事项正文（留空 = 不启用）'),
  ('article_notice_version',  '0', '文稿注意事项版本号（内容变化时 +1）'),
  -- 播出时段改由后台发布；留空则退回解析 broadcast_schedule，再退回默认三个
  ('song_slot_times',         '', '点歌可选时段（JSON，后台「点歌设置」里维护；留空=用 broadcast_schedule）'),
  -- 提交规则
  ('song_weekly_user_limit',  '2', '单个同学每周最多点歌次数（0=不限）'),
  ('song_dup_block',          '1', '同一首歌一周内不可重复（1=开 0=关）')
ON DUPLICATE KEY UPDATE `key` = `key`;


-- ---------------------------------------------------------------------------
--  已存在的表没有变化：注意事项确认仍用 notice_ack（notice_key 区分 song_submit /
--  article_submit），周次数与同曲判定都是按 submit 表实时查询，不新增字段。
--
--  手工核对「这周谁点了几次」：
--    SELECT openid, COUNT(*) AS times FROM submit
--     WHERE type = 1 AND auto_rejected = 0
--       AND create_time >= '<本周一 00:00:00>' AND create_time < '<下周一 00:00:00>'
--     GROUP BY openid ORDER BY times DESC;
--
--  手工核对「这周某首歌有没有人点过」：
--    SELECT id, openid, song_name, status FROM submit
--     WHERE type = 1 AND song_name = '晴天' AND status IN (0,1)
--       AND create_time >= '<本周一 00:00:00>' AND create_time < '<下周一 00:00:00>';
-- ---------------------------------------------------------------------------
