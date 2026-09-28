'use strict';

/**
 * 调剂成本表本地实测（阶段 5 · 步骤 1）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-scheduling-cost.js
 *
 * ⚠️ 本文件测的是**纯函数**（零 DB、零缓存），所以不需要 harness。
 *
 * 盯的是「跟源实现是不是一字节不差」+ 两条**用反例钉死**的判据：
 *   ① 周一晚 → 周二早 必须是 **30**（前后一天其他时段）
 *      周一晚 → 周一午 必须是 **10**（同一天其他时段）
 *      —— 旧的下标距离实现会把这两者算成「一样近」（都差 1），
 *         那正是当初「对不上 V1 规格第 10 节」的 bug。这条断言就是防它复发。
 *   ② `Infinity` 不能参与算术（`Infinity - Infinity = NaN` → sort 结果随机）。
 *      所以 `compareCost` 必须显式分档，`pickBest` 的 Infinity 比较必须走分支。
 *
 * 日期用**写死的固定值**（纯函数不受「今天」影响），比动态日期更可读。
 */

const path = require('path');
const cost = require(path.join(__dirname, '..', 'cloudfunctions', 'api', 'services', 'songRescheduleCost'));

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name} :: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

/* 固定时段值：2026-09-21(一) ~ 2026-09-25(五) */
const D = (d, p, t) => `2026-09-${d} ${p} ${t}`;
const MON_AM = D('21', '早间', '07:20');
const MON_NOON = D('21', '午间', '12:20');
const MON_PM = D('21', '晚间', '17:30');
const TUE_AM = D('22', '早间', '07:20');
const TUE_NOON = D('22', '午间', '12:20');
const WED_AM = D('23', '早间', '07:20');
const THU_AM = D('24', '早间', '07:20');
const FRI_AM = D('25', '早间', '07:20');

section('A. parseSlot / dayNumber');

eq('parseSlot 正常解析 date', cost.parseSlot(MON_NOON).date, '2026-09-21');
eq('parseSlot 正常解析 period', cost.parseSlot(MON_NOON).period, '午间');
eq('parseSlot 正常解析 time', cost.parseSlot(MON_NOON).time, '12:20');
eq('parseSlot 空值 → null', cost.parseSlot(null), null);
eq('parseSlot 空串 → null', cost.parseSlot(''), null);
eq('parseSlot 只有日期 → null', cost.parseSlot('2026-09-21'), null);
eq('parseSlot 缺时刻 → null', cost.parseSlot('2026-09-21 午间'), null);
eq('parseSlot 缺时段名 → null', cost.parseSlot('2026-09-21 12:20'), null);
eq('parseSlot 数字（非字符串）→ null', cost.parseSlot(20260921), null);
eq('DAY_MS 是 86400000', cost.DAY_MS, 86400000);
eq('dayNumber 同日内差 0', cost.dayNumber('2026-09-21') - cost.dayNumber('2026-09-21'), 0);
eq('dayNumber 相邻日差 1', cost.dayNumber('2026-09-22') - cost.dayNumber('2026-09-21'), 1);
eq('dayNumber 跨月（9-30 → 10-01）差 1', cost.dayNumber('2026-10-01') - cost.dayNumber('2026-09-30'), 1);
eq('dayNumber 跨年（12-31 → 01-01）差 1', cost.dayNumber('2027-01-01') - cost.dayNumber('2026-12-31'), 1);

section('B. costBetween 五档 + 不可接受');

eq('同一格 → 0（SELF）', cost.costBetween(MON_NOON, MON_NOON), 0);
eq('同一天其他时段 → 10', cost.costBetween(MON_NOON, MON_PM), 10);
eq('同一天其他时段（更早的方向也 10）', cost.costBetween(MON_PM, MON_NOON), 10);
eq('后一天同一时段 → 20', cost.costBetween(MON_AM, TUE_AM), 20);
eq('前一天同一时段 → 20（对称）', cost.costBetween(TUE_AM, MON_AM), 20);
eq('后一天其他时段 → 30', cost.costBetween(MON_AM, TUE_NOON), 30);
eq('前一天其他时段 → 30（对称）', cost.costBetween(TUE_NOON, MON_AM), 30);
eq('隔两天 → 50（FARTHER）', cost.costBetween(MON_AM, WED_AM), 50);
eq('天差 4（周一→周五）→ 50', cost.costBetween(MON_AM, FRI_AM), 50);
eq('天差 5（周→下周）→ Infinity', cost.costBetween(MON_AM, D('28', '早间', '07:20')), Infinity);
eq('解析失败（from）→ Infinity', cost.costBetween('垃圾', MON_AM), Infinity);
eq('解析失败（to）→ Infinity', cost.costBetween(MON_AM, null), Infinity);

section('C. 反例钉死：成本表 vs 下标距离（本文件存在的理由）');

// 这两个都「与首选格相距 1 个格子」，但规格要求它们**不等价**。
eq('★ 周一晚 → 周二早 = 30（不能是 10）', cost.costBetween(MON_PM, TUE_AM), 30);
eq('★ 周一晚 → 周一午 = 10（不能是 30）', cost.costBetween(MON_PM, MON_NOON), 10);
ok('★ 两者不相等（下标距离会算成一样近 → 就是当初的 bug）',
  cost.costBetween(MON_PM, TUE_AM) !== cost.costBetween(MON_PM, MON_NOON));
eq('★ 周二早 → 周一午 = 30（跨天，即使时刻更近）', cost.costBetween(TUE_AM, MON_NOON), 30);

section('D. describeCost 文案与 cost 归一');

eq('首选 cost 数字', cost.describeCost(MON_AM, MON_AM).cost, 0);
eq('首选文案', cost.describeCost(MON_AM, MON_AM).text, '首选时段');
eq('同天其他时段文案', cost.describeCost(MON_AM, MON_PM).text, '同一天其他时段');
eq('前后一天相同时段文案', cost.describeCost(MON_AM, TUE_AM).text, '前后一天相同时段');
eq('前后一天其他时段文案', cost.describeCost(MON_AM, TUE_NOON).text, '前后一天其他时段');
eq('更远日期文案', cost.describeCost(MON_AM, THU_AM).text, '更远日期');
eq('不可接受 cost 归一为 null（不是 Infinity，避免 JSON 序列化成 null 的意外语义）',
  cost.describeCost(MON_AM, D('28', '早间', '07:20')).cost, null);
eq('不可接受文案', cost.describeCost('垃圾', MON_AM).text, '不可接受');

section('E. pickBest：成本优先 + 同成本按下标升序（可复现）');

const values = [MON_AM, MON_NOON, MON_PM, TUE_AM, TUE_NOON, WED_AM, THU_AM, FRI_AM];
const indexOf = new Map(values.map((v, i) => [v, i]));

eq('单选项就选它', cost.pickBest([MON_PM], MON_NOON, indexOf), MON_PM);
// 相对 MON_NOON(周一午间)：MON_PM=10（同天异段） < TUE_NOON=20（隔天同段） < TUE_AM=30（隔天异段）
eq('★ 多选项取成本最低（10 < 20 < 30，入参顺序打乱也一样）',
  cost.pickBest([TUE_AM, TUE_NOON, MON_PM], MON_NOON, indexOf), MON_PM);
eq('首选格在选项里 → 选首选（成本 0）',
  cost.pickBest([MON_PM, MON_NOON], MON_NOON, indexOf), MON_NOON);

// 同成本（都是 10：同一天其他时段）→ 按周内下标升序 → MON_AM 在前
eq('同成本按下标升序（MON_AM 在 MON_PM 前）',
  cost.pickBest([MON_PM, MON_AM], MON_NOON, indexOf), MON_AM);
eq('同成本按下标升序（与入参顺序无关）',
  cost.pickBest([MON_AM, MON_PM], MON_NOON, indexOf), MON_AM);

// 可复现：连调 5 次结果恒定（sort 不稳定会让「手动重跑排期」结果飘）
// 相对 MON_NOON：MON_AM=10 < TUE_AM=30 < WED_AM=50 → 正确结果应是 MON_AM
const picks = new Set();
for (let i = 0; i < 5; i++) picks.add(cost.pickBest([TUE_AM, MON_AM, WED_AM], MON_NOON, indexOf));
eq('可复现：5 次调用得到同一种结果', picks.size, 1);
eq('可复现结果正确（MON_AM 成本 10 最小）', [...picks][0], MON_AM);

// 未知格（indexOf 里没有）→ 回落到 999，排在已知格之后
eq('未知格下标回落 999（同成本时排后）',
  cost.pickBest(['2026-09-21 凌晨 03:00', MON_AM], MON_NOON, indexOf), MON_AM);

// 全是不可接受时也要能返回一个（不崩）
ok('全部不可接受时仍返回某项（不崩）',
  typeof cost.pickBest([D('28', '早间', '07:20'), D('29', '早间', '07:20')], MON_NOON, indexOf) === 'string');

section('F. compareCost：Infinity 不能参与算术');

eq('相等 → 0', cost.compareCost(10, 10), 0);
eq('小数在前 → 负', cost.compareCost(10, 20), -10);
eq('大数在后 → 正', cost.compareCost(20, 10), 10);
eq('Infinity 视为最大（a 是 Inf）', cost.compareCost(Infinity, 10), 1);
eq('Infinity 视为最大（b 是 Inf）', cost.compareCost(10, Infinity), -1);
eq('两个 Infinity → 0（不是 NaN）', cost.compareCost(Infinity, Infinity), 0);
ok('两个 Infinity 的结果不是 NaN', !Number.isNaN(cost.compareCost(Infinity, Infinity)));
ok('Infinity 与有限值比较结果不是 NaN', !Number.isNaN(cost.compareCost(Infinity, 10)));

section('G. 常量完整性');

eq('COST.SELF', cost.COST.SELF, 0);
eq('COST.SAME_DAY', cost.COST.SAME_DAY, 10);
eq('COST.ADJACENT_SAME_PERIOD', cost.COST.ADJACENT_SAME_PERIOD, 20);
eq('COST.ADJACENT_OTHER_PERIOD', cost.COST.ADJACENT_OTHER_PERIOD, 30);
eq('COST.FARTHER', cost.COST.FARTHER, 50);
eq('COST.UNACCEPTABLE', cost.COST.UNACCEPTABLE, Infinity);
eq('COST_LABEL 六个键', Object.keys(cost.COST_LABEL).length, 6);
eq('COST_LABEL[Infinity] 用 ' + JSON.stringify('不可接受'), cost.COST_LABEL[Infinity], '不可接受');

/* ══════════════════════ 汇总 ══════════════════════ */
console.log(lines.join('\n'));
const total = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
console.log(`\n结论：${total} 行 / 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 2);
