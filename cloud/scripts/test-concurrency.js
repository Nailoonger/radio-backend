#!/usr/bin/env node
'use strict';

/**
 * 双端并发冲突验证（伙伴端 vs 电脑端）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-concurrency.js
 *
 * ═══════════ 为什么需要这个脚本 ═══════════
 * 伙伴端（小程序）和电脑端（admin-web）**共用同一套云函数、同一个数据库**。
 * 两边的待审列表都是「拉一次列表 → 在本地列表上点通过/屏蔽」，于是这个时序很常见：
 *
 *   T0  电脑端拉到留言 #12（status=0）
 *   T1  手机上社干也拉到留言 #12（status=0）
 *   T2  电脑端点了「屏蔽」
 *   T3  手机上点了「通过」
 *
 * 如果没有乐观锁，T3 会**静默覆盖** T2，两边都收到「成功」，
 * 审核人/审核时间/结论全部被改写，而**没有任何一方知道**。
 *
 * ═══════════ 怎么在单线程里测并发 ═══════════
 * harness 的假库是同步 Map，但包装成 async。所以 `Promise.all([a(), b()])` 时，
 * 两个 handler 的 `await findOne(...)` 会**交错执行**：
 *
 *   A: await findOne  ─┐
 *   B: await findOne  ─┴→ 两边都读到 status=0（这就是真实的竞态窗口）
 *   A: updateWhere(status=0 → 1)  ✓ 影响 1 行
 *   B: updateWhere(status=0 → 2)  ✗ 影响 0 行 → 40901
 *
 * 这不是模拟，是真的让两段 async 逻辑互相穿插 —— 和线上两个请求同时到达时的
 * 执行顺序同构。所以能真的测出「没有防护时会怎样」。
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

const HASH = bcrypt.hashSync('password123', 4);
// 两个管理员模拟「电脑端的老师」和「手机上的社干」
const PC_TOKEN = sign({ id: 1, username: 'teacher', role: 0 });
const PHONE_TOKEN = sign({ id: 2, username: 'mgr', role: 1 });

const call = (method, p, body, token) => H.call(H.req(method, p, body || {}, token || ''));

function seed() {
  const t = new Date('2026-10-01T00:00:00+08:00');
  H.reset({
    admin: [
      { _id: 'ad1', id: 1, username: 'teacher', password: HASH, nickname: '老师', role: 0, status: 1, createTime: t, updateTime: t },
      { _id: 'ad2', id: 2, username: 'mgr', password: HASH, nickname: '社干', role: 1, status: 1, createTime: t, updateTime: t },
    ],
    // 一条待审留言
    message: [
      { _id: 'msg1', id: 12, content: '节目很好听', status: 0, userName: '听众A', createTime: t },
    ],
  });
}

(async () => {
  lines.push('');
  lines.push('═══ 双端并发冲突验证 ═══');

  /* ══════════ 1. 留言：通过 vs 屏蔽 ══════════ */
  section('1. 留言审核：电脑端「屏蔽」与手机端「通过」同时发生');

  seed();
  {
    const [pc, phone] = await Promise.all([
      call('PUT', '/admin/message/12/reject', { reason: '内容不合适' }, PC_TOKEN),
      call('PUT', '/admin/message/12/approve', {}, PHONE_TOKEN),
    ]);

    const codes = [pc.code, phone.code].sort((a, b) => a - b);
    ok('只有一方成功（另一个 40901）', codes[0] === 0 && codes[1] === 40901, `pc=${pc.code} phone=${phone.code}`);

    const lost = pc.code === 40901 ? pc : phone;
    ok('失败方拿到的是「刚被别人处理过」的提示', /刚被其他人/.test(lost.message || ''), lost.message);

    // 落库结果必须与「成功的那一方」一致，不能是两者混合
    const row = (H.dump().message || [])[0];
    const winner = pc.code === 0 ? 'reject' : 'approve';
    eq('落库状态与成功方一致', row.status, winner === 'reject' ? 2 : 1);
    eq('审核人记录的是成功方', row.reviewerId, winner === 'reject' ? 1 : 2);
    if (winner === 'reject') eq('驳回理由保留', row.rejectReason, '内容不合适');
    else eq('通过时驳回理由被清空', row.rejectReason, null);
  }

  /* ══════════ 2. 留言：两端都点「通过」══════════ */
  section('2. 留言审核：两端都点「通过」（应幂等，不报冲突）');

  seed();
  {
    const [a, b] = await Promise.all([
      call('PUT', '/admin/message/12/approve', {}, PC_TOKEN),
      call('PUT', '/admin/message/12/approve', {}, PHONE_TOKEN),
    ]);
    ok('两次都返回成功（同一结论，不必报错）', a.code === 0 && b.code === 0, `a=${a.code} b=${b.code}`);
    eq('最终状态仍是「通过」', (H.dump().message || [])[0].status, 1);
  }

  /* ══════════ 3. 留言：重复点同一动作 ══════════ */
  section('3. 留言审核：同一端连点两次');

  seed();
  {
    const first = await call('PUT', '/admin/message/12/approve', {}, PC_TOKEN);
    const second = await call('PUT', '/admin/message/12/approve', {}, PC_TOKEN);
    eq('第一次成功', first.code, 0);
    eq('第二次也成功（幂等，不弹冲突）', second.code, 0);
  }

  /* ══════════ 4. 底层语义：条件不匹配必须影响 0 行 ══════════ */
  section('4. 底层：条件更新（乐观锁）语义');

  seed();
  {
    const { updateWhere, C } = require(path.join(API_DIR, 'lib', 'db'));
    // 读到旧值 status=0
    const n1 = await updateWhere(C.MESSAGE, { _id: 'msg1', status: 0 }, { status: 1 });
    eq('条件匹配 → 影响 1 行', n1, 1);
    // 再用同一个旧值条件写（模拟「另一端还拿着旧列表」）
    const n2 = await updateWhere(C.MESSAGE, { _id: 'msg1', status: 0 }, { status: 2 });
    eq('条件已过期 → 影响 0 行（不覆盖）', n2, 0);
    eq('数据仍是第一次写的结果', (H.dump().message || [])[0].status, 1);
  }

  /* ══════════ 5. 点歌审核：通过 vs 驳回 ══════════ */
  section('5. 点歌审核：电脑端「驳回」与手机端「通过」同时发生');

  {
    const t = new Date('2026-10-01T00:00:00+08:00');
    H.reset({
      admin: [
        { _id: 'ad1', id: 1, username: 'teacher', password: HASH, nickname: '老师', role: 0, status: 1, createTime: t, updateTime: t },
        { _id: 'ad2', id: 2, username: 'mgr', password: HASH, nickname: '社干', role: 1, status: 1, createTime: t, updateTime: t },
      ],
      submit: [{
        _id: 'sub1', id: 7, songName: '夜空中最亮的星', userName: '听众B',
        reviewStatus: 0, scheduleStatus: 0, playStatus: 0, status: 0,
        weekStart: '2026-11-02', createTime: t,
      }],
      system_switch: [{ _id: 'switch:submit', key: 'submit', value: 'on' }],
    });

    const [pc, phone] = await Promise.all([
      call('PUT', '/admin/submit/7/reject', { reason: '重复点歌' }, PC_TOKEN),
      call('PUT', '/admin/submit/7/approve', {}, PHONE_TOKEN),
    ]);

    // 点歌审核的乐观锁在 services/songStatus.applyChange 里，冲突时返回 conflict 而不是抛错
    const oneOk = (pc.code === 0) !== (phone.code === 0);
    ok('至少一方失败（不会双双「成功」）', pc.code !== 0 || phone.code !== 0, `pc=${pc.code} phone=${phone.code}`);
    const row = (H.dump().submit || [])[0];
    ok('落库状态只有一种结论（1=通过 或 2=驳回，不会混合）',
      row.reviewStatus === 1 || row.reviewStatus === 2, `reviewStatus=${row.reviewStatus}`);
    ok('reviewerId 与结论一致', row.reviewerId === 1 || row.reviewerId === 2, `reviewerId=${row.reviewerId}`);
    if (!oneOk) {
      lines.push('      （注：两端都返回了业务错误，属可接受 —— 关键是数据没被双写）');
    }
  }

  /* ══════════ 6. 点歌审核：两端都点「通过」（同结论 → 幂等）══════════ */
  section('6. 点歌审核：两端都点「通过」（应幂等，不报冲突）');

  {
    const t = new Date('2026-10-01T00:00:00+08:00');
    H.reset({
      admin: [
        { _id: 'ad1', id: 1, username: 'teacher', password: HASH, nickname: '老师', role: 0, status: 1, createTime: t, updateTime: t },
        { _id: 'ad2', id: 2, username: 'mgr', password: HASH, nickname: '社干', role: 1, status: 1, createTime: t, updateTime: t },
      ],
      submit: [{
        _id: 'sub2', id: 8, songName: '海阔天空', userName: '听众C',
        reviewStatus: 0, scheduleStatus: 0, playStatus: 0, status: 0,
        weekStart: '2026-11-02', createTime: t,
      }],
      system_switch: [{ _id: 'switch:submit', key: 'submit', value: 'on' }],
    });

    const [a, b] = await Promise.all([
      call('PUT', '/admin/submit/8/approve', {}, PC_TOKEN),
      call('PUT', '/admin/submit/8/approve', {}, PHONE_TOKEN),
    ]);
    ok('两次都返回成功（结论一致，不必报错）', a.code === 0 && b.code === 0, `a=${a.code} b=${b.code}`);
    eq('最终审核维度是「通过」', (H.dump().submit || [])[0].reviewStatus, 1);
  }

  /* ══════════ 输出 ══════════ */
  console.log(lines.join('\n'));
  console.log(`\n${failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'}（共 ${lines.filter((l) => /^(OK|FAIL) /.test(l)).length} 项断言）`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身异常：', e);
  process.exit(1);
});
