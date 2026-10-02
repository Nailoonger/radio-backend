'use strict';

const crypto = require('crypto');
const { ApiError, Codes } = require('../lib/response');
const R = require('./recruitmentCodes');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// 32 symbols, 16 independent five-bit samples: 80 bits of entropy.
if (ALPHABET.length !== 32) throw new Error('Invalid recruitment code alphabet');

function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function randomId() { return crypto.randomBytes(16).toString('hex'); }
function normalize(code) {
  if (typeof code !== 'string') throw new ApiError(R.INVALID_CODE, '查询码无效');
  const value = code.trim().toUpperCase();
  if (value.length !== 16 || !Array.from(value).every((c) => ALPHABET.includes(c))) {
    throw new ApiError(R.INVALID_CODE, '查询码无效');
  }
  return value;
}
function generate() {
  return Array.from(crypto.randomBytes(16), (n) => ALPHABET[n & 31]).join('');
}
function key() {
  const value = process.env.RECRUITMENT_CODE_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new ApiError(Codes.SERVER_ERROR, '招新查询凭证暂不可用，请联系广播站');
  }
  return Buffer.from(value, 'hex');
}
function encrypt(code, applicationId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(applicationId));
  const data = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(value, applicationId) {
  try {
    const [iv, tag, data] = String(value).split('.').map((s) => Buffer.from(s, 'base64'));
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !data) throw new Error('Invalid cipher');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(applicationId));
    cipher.setAuthTag(tag);
    return normalize(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  } catch (e) {
    // Never reveal crypto diagnostics, or replace a failed original credential.
    throw new ApiError(Codes.SERVER_ERROR, '招新查询凭证暂不可用，请联系广播站');
  }
}
function submissionKey(value) {
  if (typeof value !== 'string' || !/^[a-z\d_-]{22,128}$/i.test(value)) {
    throw new ApiError(Codes.PARAM_ERROR, '提交凭证无效，请返回报名页重试');
  }
  return digest(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((k) => { out[k] = canonical(value[k]); });
    return out;
  }
  return value;
}
function payloadHash(value) { return digest(JSON.stringify(canonical(value))); }

module.exports = { ALPHABET, digest, randomId, normalize, generate, encrypt, decrypt, submissionKey, payloadHash };
