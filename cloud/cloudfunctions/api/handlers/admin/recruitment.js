'use strict';

const { asAdmin, asSuper } = require('./_kit');
const recruitment = require('../../services/recruitment');
async function batches(ctx) { asAdmin(ctx); return recruitment.batches(ctx.query || {}); }
async function createBatch(ctx) { asSuper(ctx); return recruitment.createBatch(ctx.body || {}); }
async function batchDetail(ctx) { asAdmin(ctx); return recruitment.batchDetail(ctx.params.id); }
async function updateBatch(ctx) { asSuper(ctx); return recruitment.updateBatch(ctx.params.id, ctx.body || {}); }
async function publishBatch(ctx) { asSuper(ctx); return recruitment.publishBatch(ctx.params.id, ctx.body || {}); }
async function closeBatch(ctx) { asSuper(ctx); return recruitment.closeBatch(ctx.params.id, ctx.body || {}); }
async function deleteBatch(ctx) { asSuper(ctx); return recruitment.deleteBatch(ctx.params.id, ctx.body || {}); }
async function interviewPlan(ctx) { asSuper(ctx); return recruitment.interviewPlan(ctx.params.id, ctx.body || {}); }
async function generateInterviewOrder(ctx) { asSuper(ctx); return recruitment.generateInterviewOrder(ctx.params.id, ctx.body || {}); }
async function interviewOrder(ctx) { asAdmin(ctx); return recruitment.interviewOrder(ctx.params.id, ctx.query || {}); }
async function exportInterviewOrder(ctx) { asAdmin(ctx); return recruitment.exportInterviewOrder(ctx.params.id, ctx.query || {}); }
async function publishResults(ctx) { asSuper(ctx); return recruitment.publishResults(ctx.params.id, ctx.body || {}); }
async function archiveBatch(ctx) { asSuper(ctx); return recruitment.archiveBatch(ctx.params.id, ctx.body || {}); }
async function applications(ctx) { asAdmin(ctx); return recruitment.applications(ctx.query || {}); }
async function applicationDetail(ctx) { asAdmin(ctx); return recruitment.applicationDetail(ctx.params.id); }
async function review(ctx) { asAdmin(ctx); return recruitment.review(ctx.params.id, ctx.body || {}); }
async function interview(ctx) { asAdmin(ctx); return recruitment.interview(ctx.params.id, ctx.body || {}); }
module.exports = { batches, createBatch, batchDetail, updateBatch, publishBatch, closeBatch, deleteBatch, interviewPlan,
  generateInterviewOrder, interviewOrder,
  exportInterviewOrder, publishResults, archiveBatch, applications, applicationDetail, review, interview };
