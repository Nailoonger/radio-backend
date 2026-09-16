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
DROP TABLE IF EXISTS `system_switch`;

-- -----------------------------------------------------------------
--  1. user 学生用户表
-- -----------------------------------------------------------------
CREATE TABLE `user` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`      VARCHAR(64)  NOT NULL COMMENT '微信OpenID',
  `unionid`     VARCHAR(64)  DEFAULT NULL COMMENT '微信UnionID',
  `nickname`    VARCHAR(64)  DEFAULT NULL COMMENT '昵称',
  `avatar`      VARCHAR(512) DEFAULT NULL COMMENT '头像URL',
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_openid` (`openid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生用户';

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
  `want_broadcast_time`    VARCHAR(64)  DEFAULT NULL COMMENT '希望播出时段，如 2026-09-15 午间',
  `status`                 TINYINT      NOT NULL DEFAULT 0 COMMENT '0=待审核 1=已通过 2=已驳回',
  `reject_reason`          VARCHAR(255) DEFAULT NULL COMMENT '驳回理由',
  `reviewer_id`            BIGINT UNSIGNED DEFAULT NULL COMMENT '审核人',
  `review_time`            DATETIME     DEFAULT NULL COMMENT '审核时间',
  `create_time`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_openid` (`openid`),
  KEY `idx_status` (`status`),
  KEY `idx_type` (`type`),
  KEY `idx_create_time` (`create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='投稿与点歌';

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
--  8. member 风采展示成员表
-- -----------------------------------------------------------------
CREATE TABLE `member` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(32)  NOT NULL COMMENT '姓名',
  `role`           VARCHAR(32)  NOT NULL COMMENT '职务（站长/副站长/纪检长/站长助理/站员...）',
  `grade`          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '年级班级',
  `programs`       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '负责栏目（逗号分隔）',
  `avatar`         VARCHAR(512) NOT NULL COMMENT '头像 URL（/uploads/avatars/...）',
  `motto`          VARCHAR(200) DEFAULT NULL COMMENT '座右铭 / 个人简介',
  `sort`           INT          NOT NULL DEFAULT 0 COMMENT '排序权重，大者靠前',
  `is_show`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=展示 0=隐藏',
  `create_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_is_show_sort` (`is_show`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='风采展示成员';

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