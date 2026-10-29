'use strict';

// 撤回后 assignment 保留，供在原有人选上修订；正式业务必须同时检查周状态。
const { C, findOne, findMany } = require('../../lib/db');

async function isPublished(weekStart) {
  const week = await findOne(C.DUTY_WEEK, { _id: weekStart });
  return !!(week && week.state === 'published');
}

async function publishedRows(weekStart, where, limit) {
  if (!(await isPublished(weekStart))) return [];
  return findMany(C.DUTY_ASSIGNMENT, Object.assign({}, where || {}, { weekStart }), { limit: limit || 500 });
}

async function filterPublishedRows(rows) {
  const weeks = Array.from(new Set((rows || []).map((row) => row.weekStart).filter(Boolean)));
  const flags = await Promise.all(weeks.map(isPublished));
  const published = new Set(weeks.filter((week, i) => flags[i]));
  return (rows || []).filter((row) => published.has(row.weekStart));
}

module.exports = { isPublished, publishedRows, filterPublishedRows };
