'use strict';

/**
 * studentImportService —— 名册文件的「读」与「写」（只碰文件，不碰业务规则）
 *
 *   读：readSheet(buffer, filename) → 二维数组（含表头行，索引 0 = 表格第 1 行）
 *   写：buildWorkbook(sheets)       → xlsx Buffer
 *
 * ⚠️ 为什么用 exceljs 而不是 xlsx(SheetJS)：SheetJS 在 npm 上的公开版本 0.18.5 已停更
 *    且有已知漏洞，后续版本只走自建 CDN；exceljs 在 npm 上活跃维护、纯 JS、支持流式读写。
 *
 * ⚠️ 行号即 Excel 行号：读的时候**保留空行**（不压缩数组），这样报错里的「第 N 行」
 *    和用户在自己表格里看到的行号一致，不用换算。
 */

const path = require('path');
const ExcelJS = require('exceljs');

const MAX_ROWS = 5000; // 单次导入上限，防手滑传了个几万行的表

/**
 * 统一把单元格值转成字符串（数字 / 公式 / 富文本 / 日期 都能吃）
 */
function cellToText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) {
    // 极少数情况：用户把 2024 输成了日期。转成 YYYYMMDD 让归一化层再解析
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellToText(v.result);
    if (v.hyperlink !== undefined && v.text) return String(v.text);
  }
  return String(v);
}

/**
 * 轻量 CSV 解析：支持双引号包裹、引号内逗号 / 换行 / 双写引号转义、CRLF、BOM。
 * 不引第三方库 —— 规则就这些，够用且好读。
 */
function parseCsv(text) {
  let s = String(text).replace(/^\uFEFF/, ''); // BOM
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  // 收尾（最后一行没有换行符时）
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  // 去掉尾部纯空行（文件末尾多敲的回车）
  while (rows.length && rows[rows.length - 1].every((x) => String(x).trim() === '')) rows.pop();
  return rows;
}

/**
 * 读表格 → 二维数组（含表头行，行号 = 数组下标 + 1）
 * @param {Buffer} buffer
 * @param {string} filename 用于判断格式
 * @returns {Promise<{ rows: string[][], sheetName: string }>}
 */
async function readSheet(buffer, filename = '') {
  const ext = path.extname(String(filename)).toLowerCase();

  if (ext === '.csv' || ext === '.txt') {
    const rows = parseCsv(buffer.toString('utf8'));
    guardRowCount(rows);
    return { rows, sheetName: 'CSV' };
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('文件里没有工作表');

  const rows = [];
  const last = ws.rowCount;
  for (let r = 1; r <= last; r++) {
    const values = ws.getRow(r).values || []; // 1-based，[0] 恒为 undefined
    const arr = [];
    const width = Math.max(values.length - 1, 1);
    for (let c = 1; c <= width; c++) arr.push(cellToText(values[c]));
    rows.push(arr);
  }
  guardRowCount(rows);
  return { rows, sheetName: ws.name || 'Sheet1' };
}

function guardRowCount(rows) {
  if (rows.length > MAX_ROWS) {
    throw new Error(`表格行数 ${rows.length} 超过上限 ${MAX_ROWS}，请拆分后再导入`);
  }
}

/**
 * 生成 xlsx Buffer
 * @param {Array<{name:string, columns?:Array, rows:Array<Array>, note?:string}>} sheets
 *   columns: [{ header, width }]
 */
async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '菁悠广播站';
  wb.created = new Date();

  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name || 'Sheet1');
    const cols = spec.columns || [];
    if (cols.length) {
      ws.columns = cols.map((c) => ({ header: c.header, key: c.key || c.header, width: c.width || 12 }));
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).alignment = { vertical: 'middle' };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    (spec.rows || []).forEach((r) => ws.addRow(r));
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  readSheet,
  parseCsv,
  buildWorkbook,
  cellToText,
  MAX_ROWS,
};
