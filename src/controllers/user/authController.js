'use strict';

/**
 * 用户端 - 微信小程序登录
 * POST /api/user/login
 * body: { code, nickname?, avatar? }
 *
 * 流程:
 *   1. 客户端 wx.login() 拿到 code
 *   2. 服务端用 code 调用微信 code2session 换取 openid
 *   3. 用 openid 查找/创建 user 记录（无敏感信息）
 *   4. 签发 JWT 返回给客户端
 *
 * 注意: 隐私优先，只持久化昵称/头像，不强制手机号
 */
const { User } = require('../../models');
const { code2Session } = require('../../services/wechatService');
const { sign } = require('../../utils/jwt');
const { success, fail, Codes, ApiError } = require('../../utils/response');
const logger = require('../../utils/logger');

exports.login = async (req, res, next) => {
  try {
    const { code, nickname, avatar } = req.body || {};
    if (!code) {
      throw new ApiError(Codes.PARAM_ERROR, 'code不能为空');
    }

    let openid;
    try {
      const session = await code2Session(code);
      openid = session.openid;
    } catch (e) {
      logger.error('code2Session 失败:', e.message);
      // 开发/测试环境下允许 mock openid，方便无 appid 时联调
      if (process.env.MOCK_WECHAT === '1' && process.env.NODE_ENV !== 'production') {
        openid = `mock_${code}`;
        logger.warn(`[dev] 使用 mock openid: ${openid}`);
      } else {
        throw new ApiError(Codes.WECHAT_API_ERROR, '微信登录失败');
      }
    }

    // upsert 用户（隐私最小化）
    const [user] = await User.findOrCreate({
      where: { openid },
      defaults: {
        openid,
        nickname: nickname || '同学',
        avatar: avatar || '',
      },
    });

    // 已存在则更新昵称头像（用户可能修改了微信昵称）
    if (nickname || avatar) {
      await user.update({
        nickname: nickname || user.nickname,
        avatar: avatar || user.avatar,
      });
    }

    const token = sign({ openid });

    return success(res, {
      token,
      user: {
        openid: user.openid,
        nickname: user.nickname,
        avatar: user.avatar,
      },
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * 获取当前用户信息
 * GET /api/user/me
 */
exports.me = async (req, res, next) => {
  try {
    const user = await User.findOne({ where: { openid: req.user.openid } });
    if (!user) {
      throw new ApiError(Codes.NOT_FOUND, '用户不存在');
    }
    return success(res, {
      openid: user.openid,
      nickname: user.nickname,
      avatar: user.avatar,
    });
  } catch (e) {
    return next(e);
  }
};