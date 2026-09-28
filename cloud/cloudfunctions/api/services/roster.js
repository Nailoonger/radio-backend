'use strict';

/**
 * 名册工具（清洗 / 归一化 / 标签）—— 从 src/services/studentRosterService.js **原样移植**
 *
 * ⚠️ 这里只搬「用户端会用到的纯函数」；导入解析、批量建号、列表查询等管理端逻辑
 *    属于阶段 7，届时再整段搬过来（同一个文件继续加）。
 *    原文件 1094 行，大部分依赖 Sequelize 的 Op/fn/col，不能原样拿过来。
 */

/* ────────────────────────── 清洗与归一化 ────────────────────────── */

/** 全角数字 → 半角、去零宽字符、去首尾空格 */
function toHalfWidth(s) {
  return String(s)
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/** 统一清洗：去 Excel 文本撇号 / 全角空格 / 所有空白 */
function clean(v) {
  if (v === null || v === undefined) return '';
  let s = toHalfWidth(v);
  s = s.replace(/^['"`]+|['"`]+$/g, ''); // Excel 文本撇号
  s = s.replace(/\u3000/g, ' ');         // 全角空格
  return s.replace(/\s+/g, '');
}

/** 学号拼接：年级(4) + 班级(2) + 序号(2) */
function buildUsername(grade, classNo, seatNo) {
  return `${grade}${classNo}${seatNo}`;
}

/** 展示用班级标签：2024 级 1 班（班级去前导零） */
function gradeLabel(grade, classNo) {
  return `${grade} 级 ${String(classNo).replace(/^0/, '')} 班`;
}

module.exports = { toHalfWidth, clean, buildUsername, gradeLabel };
