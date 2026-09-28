'use strict';

/**
 * 用户端 · 留言
 * 迁移自 src/controllers/user/messageController.js
 *
 *   POST /user/message    提交留言（待审核）【需登录】
 *   GET  /user/message/my 我的留言列表（分页）【需登录】
 *
 * 保留原实现的全部拦截顺序与文案：
 *   空内容 40001 → 模块开关 40302 → 超 500 字 40001 → 1 分钟防刷 40901 → 内容安全 60002
 */

const { C, findOne, findMany, count, insertOne, nextId, parseId, _ } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { requireUser } = require('../../lib/auth');
const switchService = require('../../services/switch');
const { msgSecCheck } = require('../../services/wechat');
const { getAccessToken } = require('../../services/accessToken');

/** POST /user/message */
async function create(ctx) {
  const user = await requireUser(ctx);
  const { programId, content } = ctx.body || {};
  const text = typeof content === 'string' ? content : '';

  if (text.trim().length === 0) {
    throw new ApiError(Codes.PARAM_ERROR, '留言内容不能为空');
  }

  // 模块开关拦截（⚠️ assertEnabled 已改为异步：云函数没有启动预热时机）
  await switchService.assertEnabled('message');

  if (text.length > 500) {
    throw new ApiError(Codes.PARAM_ERROR, '留言不能超过500字');
  }

  // 防刷：1 分钟内同 openid 最多一条
  const since = new Date(Date.now() - 60 * 1000);
  const recent = await findOne(C.MESSAGE, { openid: user.openid, createTime: _.gte(since) });
  if (recent) {
    throw new ApiError(Codes.CONFLICT, '留言太频繁，请稍后再试');
  }

  // 内容安全检测（未开开关 / 无 token / 接口异常都放行，与原实现一致）
  const token = await getAccessToken();
  const sec = await msgSecCheck(text, token);
  if (!sec.pass) {
    throw new ApiError(Codes.CONTENT_BLOCKED, '留言包含敏感内容');
  }

  // 冗余昵称头像，便于审核展示
  // ⚠️⚠️ 与原实现**逐字一致**：这里按 `openid` 查 user。
  //    但账号用户的 JWT.openid 是「学号」，而 user 文档的 openid 字段为空
  //    （学生账号没有微信 openid）→ 查不到 → 昵称兜底为「同学」。
  //    这是账号体系改造时留下的**已知行为**，不是本次移植引入的；
  //    若要改成「账号用户取 remark/name」，属业务决策，需单独确认后再动。
  const u = await findOne(C.USER, { openid: user.openid });
  const pid = parseId(programId);

  const id = await nextId(C.MESSAGE);
  await insertOne(C.MESSAGE, {
    id,
    openid: user.openid,
    programId: pid, // 对广播站整体留言时为 null
    nickname: (u && u.nickname) || '同学',
    avatar: (u && u.avatar) || '',
    content: text,
    status: 0, // 0=待审核 1=展示 2=驳回
    rejectReason: null,
    reviewerId: null,
    reviewTime: null,
    createTime: new Date(),
  });

  return { id };
}

/** GET /user/message/my */
async function myList(ctx) {
  const user = await requireUser(ctx);
  const q = ctx.query || {};
  const page = parseInt(q.page, 10) || 1;
  const pageSize = parseInt(q.pageSize, 10) || 10;
  const where = { openid: user.openid };

  const [rows, total] = await Promise.all([
    findMany(C.MESSAGE, where, {
      orderBy: [['createTime', 'desc']],
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
    count(C.MESSAGE, where),
  ]);

  return { list: rows, total, page, pageSize };
}

module.exports = { create, myList };
