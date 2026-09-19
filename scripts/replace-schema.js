// 替换 schema.sql 中的 member 表为 cadre + staff
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'sql', 'schema.sql');
let content = fs.readFileSync(file, 'utf8');

const oldMemberBlock = `-- -----------------------------------------------------------------
--  8. member 风采展示成员表
-- -----------------------------------------------------------------
CREATE TABLE \`member\` (
  \`id\`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\`           VARCHAR(32)  NOT NULL COMMENT '姓名',
  \`role\`           VARCHAR(32)  NOT NULL COMMENT '职务（站长/副站长/纪检长/站长助理/站员）',
  \`department\`     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '所属部门：播音部 / 主持部 / 编辑部',
  \`grade\`          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '年级班级',
  \`programs\`       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '负责栏目（逗号分隔）',
  \`avatar\`         VARCHAR(512) NOT NULL COMMENT '头像 URL（/uploads/avatars/...）',
  \`motto\`          VARCHAR(200) DEFAULT NULL COMMENT '座右铭 / 个人简介',
  \`sort\`           INT          NOT NULL DEFAULT 0 COMMENT '排序权重，大者靠前',
  \`is_show\`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=展示 0=隐藏',
  \`create_time\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`update_time\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_is_show_sort\` (\`is_show\`, \`sort\`),
  KEY \`idx_department_sort\` (\`department\`, \`sort\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='风采展示成员';`;

const newBlock = `-- -----------------------------------------------------------------
--  8. cadre 社干（社团管理层）
-- -----------------------------------------------------------------
CREATE TABLE \`cadre\` (
  \`id\`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\`           VARCHAR(32)  NOT NULL COMMENT '姓名',
  \`role\`           VARCHAR(32)  NOT NULL COMMENT '职务（站长/副站长/纪检长/站长助理）',
  \`grade\`          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '年级班级',
  \`avatar\`         VARCHAR(512) NOT NULL COMMENT '头像 URL（/uploads/avatars/...）',
  \`motto\`          VARCHAR(200) DEFAULT NULL COMMENT '座右铭 / 个人简介',
  \`sort\`           INT          NOT NULL DEFAULT 0 COMMENT '排序权重，大者靠前',
  \`is_show\`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=展示 0=隐藏',
  \`create_time\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`update_time\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_is_show_sort\` (\`is_show\`, \`sort\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='社干';

-- -----------------------------------------------------------------
--  9. staff 部门人员
-- -----------------------------------------------------------------
CREATE TABLE \`staff\` (
  \`id\`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\`           VARCHAR(32)  NOT NULL COMMENT '姓名',
  \`role\`           VARCHAR(32)  NOT NULL COMMENT '岗位（主播/主持/编辑/记者/技术员）',
  \`department\`     VARCHAR(32)  NOT NULL COMMENT '所属部门：播音部 / 主持部 / 编辑部',
  \`grade\`          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '年级班级',
  \`programs\`       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '负责栏目（逗号分隔）',
  \`avatar\`         VARCHAR(512) NOT NULL COMMENT '头像 URL（/uploads/avatars/...）',
  \`motto\`          VARCHAR(200) DEFAULT NULL COMMENT '座右铭 / 个人简介',
  \`sort\`           INT          NOT NULL DEFAULT 0 COMMENT '排序权重，大者靠前',
  \`is_show\`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=展示 0=隐藏',
  \`create_time\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`update_time\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_is_show_sort\` (\`is_show\`, \`sort\`),
  KEY \`idx_department_sort\` (\`department\`, \`sort\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='部门人员';

-- 旧的 member 表已废弃，由 cadre + staff 取代`;

if (!content.includes(oldMemberBlock)) {
  console.error('OLD MEMBER BLOCK NOT FOUND');
  process.exit(1);
}

content = content.replace(oldMemberBlock, newBlock);
fs.writeFileSync(file, content);
console.log('OK: schema.sql updated');