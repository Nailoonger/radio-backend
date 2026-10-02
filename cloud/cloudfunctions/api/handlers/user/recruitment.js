'use strict';

// Public recruitment never invokes student authentication. The platform identity
// is used solely by the rate limiter, not as the application's owner.
const recruitment = require('../../services/recruitment');
const { rate } = require('../../services/recruitmentStore');
async function current() { return recruitment.current(); }
async function apply(ctx) { await rate(ctx, 'apply'); return recruitment.apply(ctx.body || {}); }
async function query(ctx) { await rate(ctx, 'query'); return recruitment.query(ctx.body || {}); }
async function update(ctx) { await rate(ctx, 'mutate'); return recruitment.mutate(ctx.body || {}, 'update'); }
async function withdraw(ctx) { await rate(ctx, 'mutate'); return recruitment.mutate(ctx.body || {}, 'withdraw'); }
async function resubmit(ctx) { await rate(ctx, 'mutate'); return recruitment.mutate(ctx.body || {}, 'resubmit'); }
module.exports = { current, apply, query, update, withdraw, resubmit };
