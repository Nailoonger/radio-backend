'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * 生成 JWT
 * @param {object} payload  例如 { id, username, role }
 */
function sign(payload) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

/**
 * 校验 JWT
 * @throws {Error} token 无效时抛出
 */
function verify(token) {
  return jwt.verify(token, config.jwt.secret);
}

module.exports = { sign, verify };