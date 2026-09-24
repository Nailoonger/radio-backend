-- =====================================================================
--  点歌排期协议版（2026-09-24，见 docs/song-protocol.md）
--
--  这次迁移做三件事：
--    ① submit 增加「审核 / 排期 / 播放」三个正交维度 + 调剂开关 + 两个时刻列
--    ② 新增 weekly_schedule / assignment_log / request_status_log 三张表
--    ③ 把老数据按「已经发生的事实」保守回填到新维度（幂等，可重复跑）
--
--  ⚠️ 与 v2 最大的语义变化（管理员必须知道）：
--     v2 有「提交即占位」—— status=0/1/4 都占着格子。
--     协议版占位口径 = review_status=APPROVED AND schedule_status=APPROVED。
--     所以老数据里 status=0（待审占位）迁移后**不再占位**，位置要等审核通过后
--     由第一轮排期重新分配。这是方案变更的一部分，不是丢数据。
--
--  上线顺序：跑本脚本 → 部署新代码 → 管理端点一次「执行调度」兜底
--            （POST /api/admin/submit/queue/sweep）把历史周的排期重算一遍。
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
--  ① submit：三维状态 + 调剂开关 + 时刻列
-- ---------------------------------------------------------------------
ALTER TABLE `submit`
  ADD COLUMN `review_status`     TINYINT NOT NULL DEFAULT 0
    COMMENT '0=PENDING待审 1=APPROVED审核通过 2=REJECTED审核驳回 3=CANCELLED已取消',
  ADD COLUMN `schedule_status`   TINYINT NOT NULL DEFAULT 0
    COMMENT '0=UNASSIGNED未参与排期 1=APPROVED已获正式位 2=WAITING候补 3=AUTO_REJECTED无位自动驳回',
  ADD COLUMN `play_status`       TINYINT NOT NULL DEFAULT 0
    COMMENT '0=NOT_PLAYED未播 1=PLAYED已播',
  ADD COLUMN `allow_reschedule`  TINYINT NOT NULL DEFAULT 1
    COMMENT '1=允许系统在首选时段满时调剂到别的时段，0=只接受首选时段',
  ADD COLUMN `assigned_at`       DATETIME DEFAULT NULL COMMENT '拿到正式位的时刻',
  ADD COLUMN `played_at`         DATETIME DEFAULT NULL COMMENT '标记为已播的时刻';

ALTER TABLE `submit`
  ADD KEY `idx_review_sched` (`type`, `review_status`, `schedule_status`),
  ADD KEY `idx_assigned`     (`scheduled_slot`, `review_status`, `schedule_status`);

-- status 的注释改成「派生镜像」（真值是上面三个维度）
ALTER TABLE `submit`
  MODIFY COLUMN `status` TINYINT NOT NULL DEFAULT 0
    COMMENT '派生镜像：0待审 1已排期 2已驳回 3候补中 4保留 5已播放 6已通过待排期 7已取消（由三个维度算出，勿单独写）';

-- queue_at / promoted_at 保留字段但不再写入（v2 的全局 FIFO 队列已废除）
ALTER TABLE `submit`
  MODIFY COLUMN `queue_at`    DATETIME DEFAULT NULL COMMENT '[已废弃] v2 候补队列时刻，协议版不再写入',
  MODIFY COLUMN `promoted_at` DATETIME DEFAULT NULL COMMENT '[已废弃] v2 递补时刻，协议版不再写入';

-- ---------------------------------------------------------------------
--  ② 老数据回填（保守口径，可重复执行）
--     · status=1 已排期        → 审核通过 + 已排期（占位）
--     · status=4 已补位未审    → 审核通过 + 已排期（它确实占着位子，保住）
--     · status=3 候补中        → 审核通过 + 候补
--     · status=0 待审          → 待审 + 未排期（协议版提交不再占位）
--     · status=2 人工驳回      → 审核驳回
--     · status=2 系统驳回      → 审核通过 + 无位自动驳回（保留「系统驳的」痕迹）
-- ---------------------------------------------------------------------
UPDATE `submit`
   SET `review_status` = CASE
         WHEN `status` = 1 THEN 1
         WHEN `status` = 4 THEN 1
         WHEN `status` = 3 THEN 1
         WHEN `status` = 2 AND `auto_rejected` = 1 THEN 1
         ELSE 0 END,
       `schedule_status` = CASE
         WHEN `status` = 1 THEN 1
         WHEN `status` = 4 THEN 1
         WHEN `status` = 3 THEN 2
         WHEN `status` = 2 AND `auto_rejected` = 1 THEN 3
         ELSE 0 END,
       `play_status` = 0,
       `allow_reschedule` = 1
 WHERE `type` = 1;

-- 镜像列重算，保证与三维一致
UPDATE `submit`
   SET `status` = CASE
         WHEN `review_status` = 3 THEN 7
         WHEN `review_status` = 2 THEN 2
         WHEN `schedule_status` = 3 THEN 2
         WHEN `schedule_status` = 2 THEN 3
         WHEN `schedule_status` = 1 THEN 1
         WHEN `review_status` = 1 THEN 6
         ELSE 0 END
 WHERE `type` = 1;

-- ---------------------------------------------------------------------
--  ③ weekly_schedule 周排期（一周一行；承载周状态机与时间锚点）
--     时间锚点由 KV 点歌窗口派生后落库；DRAFT/APPLICATION/REVIEW 由时间自动推进，
--     SCHEDULING / LOCKED / CANCELLED 是写动作的结果。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `weekly_schedule` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `week_start_date`       DATE         NOT NULL COMMENT '该播出周的周一日期（北京时间）',
  `application_start_at`  DATETIME     DEFAULT NULL COMMENT '申请（收歌）开始时刻',
  `application_end_at`    DATETIME     DEFAULT NULL COMMENT '申请截止时刻',
  `review_start_at`       DATETIME     DEFAULT NULL COMMENT '审核开始时刻（= 申请截止）',
  `review_end_at`         DATETIME     DEFAULT NULL COMMENT '审核截止时刻（= 锁定时刻）',
  `schedule_lock_at`      DATETIME     DEFAULT NULL COMMENT '排期锁定时刻，到点跑最后一次调度并驳回剩余候补',
  `status`                VARCHAR(16)  NOT NULL DEFAULT 'DRAFT'
    COMMENT 'DRAFT/APPLICATION/REVIEW/SCHEDULING/LOCKED/CANCELLED',
  `locked_at`             DATETIME     DEFAULT NULL COMMENT '实际锁定时刻（手动提前锁会与 schedule_lock_at 不同）',
  `created_by`            BIGINT UNSIGNED DEFAULT NULL COMMENT '创建人 admin.id；自动懒创建为 NULL',
  `created_at`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `week_start_date` (`week_start_date`),
  KEY `idx_week_start` (`week_start_date`),
  KEY `idx_week_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='周排期（一周一行，协议版）';

-- ---------------------------------------------------------------------
--  ④ assignment_log 排期变动日志
--     时段身份用**时段值字符串**（如 2026-09-21 午间 12:20），不是数字 id ——
--     本项目没有单建 schedule_slots 表，格子由 broadcastSlotService 派生。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `assignment_log` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id`       BIGINT UNSIGNED NOT NULL COMMENT 'FK submit.id',
  `from_slot`        VARCHAR(64)  DEFAULT NULL COMMENT '原时段值；第一轮排期为 NULL',
  `to_slot`          VARCHAR(64)  DEFAULT NULL COMMENT '新时段值；释放位子时可为 NULL',
  `assignment_type`  VARCHAR(24)  NOT NULL COMMENT 'INITIAL/RESCHEDULED/MANUAL/PROMOTED/RELEASED',
  `reason`           VARCHAR(64)  DEFAULT NULL COMMENT 'ORIGINAL_SLOT_FULL / SLOT_RELEASED / INITIAL_ALLOCATION / MANUAL …',
  `operator_id`      BIGINT UNSIGNED DEFAULT NULL COMMENT '人工操作的管理员 id；系统调度为 NULL',
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_assign_request` (`request_id`),
  KEY `idx_assign_type_created` (`assignment_type`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点歌排期变动日志（协议版）';

-- ---------------------------------------------------------------------
--  ⑤ request_status_log 状态变更日志
--     回答「这首歌为什么现在是这个状态」；与 assignment_log 分工：
--     这张记**状态**，那张记**时段**。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `request_status_log` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id`     BIGINT UNSIGNED NOT NULL COMMENT 'FK submit.id',
  `operator_id`    BIGINT UNSIGNED DEFAULT NULL COMMENT '管理员 id；系统动作为 NULL',
  `operator_name`  VARCHAR(32)  DEFAULT NULL COMMENT 'SYSTEM / ADMIN / USER',
  `dimension`      VARCHAR(16)  NOT NULL DEFAULT 'review' COMMENT 'review / schedule / play',
  `from_status`    VARCHAR(24)  DEFAULT NULL COMMENT '变更前状态名，如 PENDING_REVIEW / WAITING',
  `to_status`      VARCHAR(24)  NOT NULL COMMENT '变更后状态名',
  `reason`         VARCHAR(255) DEFAULT NULL,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_rstatus_request` (`request_id`),
  KEY `idx_rstatus_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点歌状态变更日志（协议版）';

-- ---------------------------------------------------------------------
--  ⑥ 已废弃的配置（协议版候补没有人数上限，审核通过的人都应能排队）
-- ---------------------------------------------------------------------
DELETE FROM `system_setting` WHERE `key` = 'song_queue_limit';

-- ---------------------------------------------------------------------
--  回滚（谨慎，会丢协议版数据）：
--    DROP TABLE IF EXISTS `request_status_log`;
--    DROP TABLE IF EXISTS `assignment_log`;
--    DROP TABLE IF EXISTS `weekly_schedule`;
--    ALTER TABLE `submit` DROP KEY `idx_review_sched`, DROP KEY `idx_assigned`;
--    ALTER TABLE `submit`
--      DROP COLUMN `review_status`, DROP COLUMN `schedule_status`, DROP COLUMN `play_status`,
--      DROP COLUMN `allow_reschedule`, DROP COLUMN `assigned_at`, DROP COLUMN `played_at`;
-- ---------------------------------------------------------------------
