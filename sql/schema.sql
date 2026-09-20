-- =================================================================
--  菁悠广播站 - 数据库结构
--  数据库: MySQL 8.0
--  字符集: utf8mb4 (支持 emoji 和生僻字)
--  说明:    与 Sequelize 模型保持一致，开发环境若使用 SQLite，
--           Sequelize 会自动同步（sync）生成表结构；
--           生产环境推荐使用本脚本手工初始化，便于运维审计。
-- 包含表: user, admin, submit, program, notice, message, system_setting, member, system_switch
-- =================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `user`;
DROP TABLE IF EXISTS `admin`;
DROP TABLE IF EXISTS `submit`;
DROP TABLE IF EXISTS `program`;
DROP TABLE IF EXISTS `notice`;
DROP TABLE IF EXISTS `message`;
DROP TABLE IF EXISTS `member`;
DROP TABLE IF EXISTS `import_batch`;
DROP TABLE IF EXISTS `system_switch`;

-- -----------------------------------------------------------------
--  1. user 学生用户表
-- -----------------------------------------------------------------
CREATE TABLE `user` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`          VARCHAR(64)  DEFAULT NULL COMMENT '微信OpenID（学生账号体系下为空）',
  `username`        VARCHAR(32)  DEFAULT NULL COMMENT '登录账号=入学年级+班级+序号，如 20240101',
  `password`        VARCHAR(72)  DEFAULT NULL COMMENT 'bcrypt 哈希；老微信用户为空',
  `grade`           VARCHAR(8)   DEFAULT NULL COMMENT '入学年级，如 2024',
  `class_no`        VARCHAR(4)   DEFAULT NULL COMMENT '班级，如 01',
  `seat_no`         VARCHAR(4)   DEFAULT NULL COMMENT '序号，如 01',
  `remark`          VARCHAR(64)  DEFAULT NULL COMMENT '备注（可存姓名）',
  `status`          TINYINT      NOT NULL DEFAULT 1 COMMENT '1=启用 0=禁用',
  `pwd_changed_at`  DATETIME     DEFAULT NULL COMMENT '为空=仍是初始密码 user+学号',
  `last_login_at`   DATETIME     DEFAULT NULL COMMENT '最近登录时间',
  `login_count`     INT          NOT NULL DEFAULT 0 COMMENT '累计登录次数',
  `import_batch_id` INT          DEFAULT NULL COMMENT '来源导入批次',
  `unionid`         VARCHAR(64)  DEFAULT NULL COMMENT '微信UnionID',
  `nickname`        VARCHAR(64)  DEFAULT NULL COMMENT '昵称',
  `avatar`          VARCHAR(512) DEFAULT NULL COMMENT '头像URL',
  `create_time`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_openid` (`openid`),
  UNIQUE KEY `uk_username` (`username`),
  UNIQUE KEY `uk_grade_class_seat` (`grade`, `class_no`, `seat_no`),
  KEY `idx_grade_class` (`grade`, `class_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生用户 / 学生账号';

-- -----------------------------------------------------------------
--  1.1 import_batch 学生名册导入批次（支持按批撤销）
-- -----------------------------------------------------------------
CREATE TABLE `import_batch` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `filename`    VARCHAR(255) NOT NULL DEFAULT '' COMMENT '上传的原始文件名',
  `total`       INT          NOT NULL DEFAULT 0 COMMENT '表格总数据行数',
  `created`     INT          NOT NULL DEFAULT 0 COMMENT '新建账号数',
  `updated`     INT          NOT NULL DEFAULT 0 COMMENT '覆盖更新数',
  `skipped`     INT          NOT NULL DEFAULT 0 COMMENT '跳过数（已激活受保护）',
  `invalid`     INT          NOT NULL DEFAULT 0 COMMENT '异常行数',
  `operator_id` INT          DEFAULT NULL COMMENT '操作管理员 id',
  `operator`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作管理员用户名',
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_create_time` (`create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生名册导入批次';

-- -----------------------------------------------------------------
--  2. admin 管理员表
-- -----------------------------------------------------------------
CREATE TABLE `admin` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(64)  NOT NULL COMMENT '登录账号',
  `password`      VARCHAR(255) NOT NULL COMMENT 'bcrypt加密',
  `nickname`      VARCHAR(64)  DEFAULT NULL COMMENT '昵称',
  `role`          TINYINT      NOT NULL DEFAULT 1 COMMENT '0=超级管理员(老师) 1=普通管理员(社员)',
  `status`        TINYINT      NOT NULL DEFAULT 1 COMMENT '0=禁用 1=启用',
  `last_login_at` DATETIME     DEFAULT NULL,
  `create_time`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员';

-- -----------------------------------------------------------------
--  3. submit 投稿/点歌表（核心表）
-- -----------------------------------------------------------------
CREATE TABLE `submit` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`                 VARCHAR(64)  NOT NULL COMMENT '提交人openid',
  `type`                   TINYINT      NOT NULL COMMENT '1=点歌 2=文稿',
  `song_name`              VARCHAR(128) DEFAULT NULL COMMENT '歌曲名',
  `singer`                 VARCHAR(128) DEFAULT NULL COMMENT '歌手',
  `wish_content`           VARCHAR(500) DEFAULT NULL COMMENT '祝福语',
  `article_title`          VARCHAR(255) DEFAULT NULL COMMENT '文稿标题',
  `article_content`        TEXT         DEFAULT NULL COMMENT '文稿正文',
  `want_broadcast_time`    VARCHAR(64)  DEFAULT NULL COMMENT '学生首选播出时段，如 2026-09-21 午间 12:20（意愿数据，永不被覆盖）',
  `scheduled_slot`         VARCHAR(64)  DEFAULT NULL COMMENT '实际排期时段（候补补位后可能与首选不同；候补中为空）',
  `queue_at`               DATETIME     DEFAULT NULL COMMENT '进入候补队列时刻（FIFO 排序键）',
  `promoted_at`            DATETIME     DEFAULT NULL COMMENT '递补为占位状态的时刻',
  `status`                 TINYINT      NOT NULL DEFAULT 0 COMMENT '0=待审 1=已排期 2=已驳回 3=候补中 4=已补位待审',
  `reject_reason`          VARCHAR(255) DEFAULT NULL COMMENT '驳回理由',
  `reviewer_id`            BIGINT UNSIGNED DEFAULT NULL COMMENT '审核人',
  `review_time`            DATETIME     DEFAULT NULL COMMENT '审核时间',
  `auto_rejected`          TINYINT      NOT NULL DEFAULT 0 COMMENT '1=系统自动驳回（满额/逾期），0=人工处理',
  `create_time`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_openid` (`openid`),
  KEY `idx_status` (`status`),
  KEY `idx_type` (`type`),
  KEY `idx_create_time` (`create_time`),
  KEY `idx_type_status_create` (`type`, `status`, `create_time`),
  KEY `idx_sched_status` (`scheduled_slot`, `status`),
  KEY `idx_queue` (`status`, `queue_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='投稿与点歌';

-- -----------------------------------------------------------------
--  4.1 song_quota 点歌名额计数器（日 / 周各一行）
--      并发要点：UNIQUE(period, period_key) 保证同周期只有一行；
--      used 只允许用带条件的单条 UPDATE 自增（见 services/songQuotaService.js）
-- -----------------------------------------------------------------
CREATE TABLE `song_quota` (
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

-- -----------------------------------------------------------------
--  4.2 notice_ack 注意事项确认记录（点歌前须确认）
--      每人每份一行：UNIQUE(openid, notice_key)
--      version = 确认时那份内容的版本号；管理员改内容 → 版本 +1 → 全部重新确认
-- -----------------------------------------------------------------
CREATE TABLE `notice_ack` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`      VARCHAR(64)     NOT NULL COMMENT '确认人',
  `notice_key`  VARCHAR(32)     NOT NULL COMMENT '注意事项标识，如 song_submit',
  `version`     INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '确认时的内容版本号',
  `create_time` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_openid_notice` (`openid`, `notice_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='注意事项确认记录';

-- -----------------------------------------------------------------
--  4. program 节目表
-- -----------------------------------------------------------------
CREATE TABLE `program` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`          VARCHAR(128) NOT NULL COMMENT '节目名',
  `host`           VARCHAR(128) DEFAULT NULL COMMENT '主持人',
  `broadcast_time` VARCHAR(64)  NOT NULL COMMENT '开播时间描述，如 周一 12:30-13:00',
  `broadcast_date` DATE         DEFAULT NULL COMMENT '具体日期（用于日历视图）',
  `desc`           TEXT         DEFAULT NULL COMMENT '简介',
  `cover`          VARCHAR(512) DEFAULT NULL COMMENT '封面图',
  `is_show`        TINYINT      NOT NULL DEFAULT 1 COMMENT '0=隐藏 1=展示',
  `is_live`        TINYINT      NOT NULL DEFAULT 0 COMMENT '0=未开播 1=正在直播',
  `sort`           INT          NOT NULL DEFAULT 0 COMMENT '排序',
  `create_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_broadcast_date` (`broadcast_date`),
  KEY `idx_is_show` (`is_show`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='节目';

-- -----------------------------------------------------------------
--  5. notice 公告表
-- -----------------------------------------------------------------
CREATE TABLE `notice` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`       VARCHAR(255) NOT NULL COMMENT '标题',
  `content`     TEXT         NOT NULL COMMENT '内容',
  `is_top`      TINYINT      NOT NULL DEFAULT 0 COMMENT '0=否 1=置顶',
  `is_show`     TINYINT      NOT NULL DEFAULT 1 COMMENT '0=隐藏 1=展示',
  `publisher_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '发布人',
  `publish_time` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_is_show` (`is_show`),
  KEY `idx_publish_time` (`publish_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公告';

-- -----------------------------------------------------------------
--  6. message 留言表
-- -----------------------------------------------------------------
CREATE TABLE `message` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`      VARCHAR(64)  NOT NULL COMMENT '留言人',
  `program_id`  BIGINT UNSIGNED DEFAULT NULL COMMENT '关联节目ID，可为空（对广播站整体留言）',
  `nickname`    VARCHAR(64)  DEFAULT NULL COMMENT '冗余昵称',
  `avatar`      VARCHAR(512) DEFAULT NULL COMMENT '冗余头像',
  `content`     VARCHAR(500) NOT NULL COMMENT '留言内容',
  `status`      TINYINT      NOT NULL DEFAULT 0 COMMENT '0=待审核 1=展示 2=驳回',
  `reject_reason` VARCHAR(255) DEFAULT NULL,
  `reviewer_id` BIGINT UNSIGNED DEFAULT NULL,
  `review_time` DATETIME     DEFAULT NULL,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_openid` (`openid`),
  KEY `idx_program_id` (`program_id`),
  KEY `idx_status` (`status`),
  KEY `idx_create_time` (`create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='留言';

-- -----------------------------------------------------------------
--  7. system_setting 系统设置表（key-value）
-- -----------------------------------------------------------------
CREATE TABLE `system_setting` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key`         VARCHAR(64)  NOT NULL,
  `value`       TEXT         DEFAULT NULL,
  `desc`        VARCHAR(255) DEFAULT NULL,
  `update_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统设置';

-- -----------------------------------------------------------------
--  8. cadre 社干（社团管理层）
-- -----------------------------------------------------------------
CREATE TABLE `cadre` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(32)  NOT NULL COMMENT '姓名',
  `role`           VARCHAR(32)  NOT NULL COMMENT '职务（站长/副站长/纪检长/站长助理）',
  `grade`          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '年级班级',
  `avatar`         VARCHAR(512) NOT NULL COMMENT '头像 URL（/uploads/avatars/...）',
  `motto`          VARCHAR(200) DEFAULT NULL COMMENT '座右铭 / 个人简介',
  `sort`           INT          NOT NULL DEFAULT 0 COMMENT '排序权重，大者靠前',
  `is_show`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=展示 0=隐藏',
  `create_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_is_show_sort` (`is_show`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='社干';

-- -----------------------------------------------------------------
--  9. staff 部门人员
-- -----------------------------------------------------------------
CREATE TABLE `staff` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(32)  NOT NULL COMMENT '姓名',
  `role`           VARCHAR(32)  NOT NULL COMMENT '岗位（主播/主持/编辑/记者/技术员）',
  `department`     VARCHAR(32)  NOT NULL COMMENT '所属部门：播音部 / 主持部 / 编辑部',
  `grade`          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '年级班级',
  `programs`       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '负责栏目（逗号分隔）',
  `avatar`         VARCHAR(512) NOT NULL COMMENT '头像 URL（/uploads/avatars/...）',
  `motto`          VARCHAR(200) DEFAULT NULL COMMENT '座右铭 / 个人简介',
  `sort`           INT          NOT NULL DEFAULT 0 COMMENT '排序权重，大者靠前',
  `is_show`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=展示 0=隐藏',
  `create_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_is_show_sort` (`is_show`, `sort`),
  KEY `idx_department_sort` (`department`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='部门人员';

-- 旧的 member 表已废弃，由 cadre + staff 取代

-- -----------------------------------------------------------------
--  9. system_switch 模块开关表
-- -----------------------------------------------------------------
CREATE TABLE `system_switch` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key`         VARCHAR(64)  NOT NULL COMMENT 'submit_song/submit_article/message/member',
  `value`       VARCHAR(8)   NOT NULL DEFAULT 'on' COMMENT "'on' | 'off'",
  `desc`        VARCHAR(255) DEFAULT NULL,
  `updated_by`  BIGINT UNSIGNED DEFAULT NULL COMMENT '最后修改人 admin.id',
  `update_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模块开关';

-- -----------------------------------------------------------------
--  初始设置（广播站简介、开播时间等）
-- -----------------------------------------------------------------
INSERT INTO `system_setting`(`key`,`value`,`desc`) VALUES
('station_intro', '菁菁校园情，悠悠广播声。\n\n菁悠广播站成立于2005年，由一群热爱声音、热爱校园的同学们组成。我们用声音传递资讯，用音乐温暖日常。', '广播站介绍'),
('broadcast_schedule', '午间档 12:30-13:00 | 下午档 17:00-17:30', '开播时间'),
('contact', '广播站社长 13800138000', '联系方式');

-- -----------------------------------------------------------------
--  初始超级管理员（密码：admin123456，bcrypt hash）
--  生成方式: bcrypt.hashSync('admin123456', 10)
--  注意: 首次部署后请立即修改密码！
-- -----------------------------------------------------------------
INSERT INTO `admin`(`username`,`password`,`nickname`,`role`,`status`) VALUES
('teacher', '$2a$10$Kx9GZSF3FFxgJ9uKViIne.jndmwowJaWkNecq.Uwv5CeriBkUfqfy', '指导老师', 0, 1);

-- -----------------------------------------------------------------
--  初始示例节目（用于演示）
-- -----------------------------------------------------------------
INSERT INTO `program`(`title`,`host`,`broadcast_time`,`broadcast_date`,`desc`,`is_show`,`sort`) VALUES
('午间音乐汇', '小李', '周一至周五 12:30-13:00', CURDATE(), '精选校园流行歌曲，伴你度过午休时光。', 1, 1),
('校园新闻速递', '小红', '周一 17:00-17:30', CURDATE(), '播报本周校园大事。', 1, 2),
('晚安故事', '小张', '周五 21:30-22:00', DATE_ADD(CURDATE(), INTERVAL 4 DAY), '为住校生送上一段温柔的睡前故事。', 1, 3);

-- -----------------------------------------------------------------
--  初始模块开关（全部开启）
-- -----------------------------------------------------------------
INSERT INTO `system_switch`(`key`,`value`,`desc`) VALUES
('submit_song',    'on', '点歌投稿'),
('submit_article', 'on', '文稿投稿'),
('message',        'on', '节目留言'),
('member',         'on', '风采展示');

SET FOREIGN_KEY_CHECKS = 1;
-- ── 整届清理回执（v8「清理完成」屏）────────────────────────────────
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
