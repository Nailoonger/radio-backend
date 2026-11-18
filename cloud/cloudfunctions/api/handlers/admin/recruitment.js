'use strict';

const { asSuper } = require('./_kit');
/**
 * 招新管理权限（2026-11-19 第五位）
 *
 * ⚠️ 原来这里全是 `asAdmin` —— 等于凡是能登录后台的社干都能看报名表、能改面试结论。
 *    报名表里是学生姓名/班级/联系方式，属于该按人分发的东西，不是「有账号就都能看」。
 *    现在读/审/面这半边走 `asRecruiter`（超管恒过 + 社干看 recruit 位），
 *    建批次/发布/发榜这些「改全局」的动作仍然只有超管（`asSuper`）。
 * ⚠️ 跨模块 require 是**单向**的（本文件 → partner/_kit）：partner/_kit 不认识 admin/_kit，
 *    不会成环。权限口径只有 partner/_kit 一套，别在这儿另写一份判断。
 */
const { asRecruiter } = require('../partner/_kit');
const recruitment = require('../../services/recruitment');
async function batches(ctx) { await asRecruiter(ctx); return recruitment.batches(ctx.query || {}); }
async function createBatch(ctx) { asSuper(ctx); return recruitment.createBatch(ctx.body || {}); }
async function batchDetail(ctx) { await asRecruiter(ctx); return recruitment.batchDetail(ctx.params.id); }
async function updateBatch(ctx) { asSuper(ctx); return recruitment.updateBatch(ctx.params.id, ctx.body || {}); }
async function publishBatch(ctx) { asSuper(ctx); return recruitment.publishBatch(ctx.params.id, ctx.body || {}); }
async function closeBatch(ctx) { asSuper(ctx); return recruitment.closeBatch(ctx.params.id, ctx.body || {}); }
async function deleteBatch(ctx) { asSuper(ctx); return recruitment.deleteBatch(ctx.params.id, ctx.body || {}); }
async function interviewPlan(ctx) { asSuper(ctx); return recruitment.interviewPlan(ctx.params.id, ctx.body || {}); }
async function generateInterviewOrder(ctx) { asSuper(ctx); return recruitment.generateInterviewOrder(ctx.params.id, ctx.body || {}); }
async function interviewOrder(ctx) { await asRecruiter(ctx); return recruitment.interviewOrder(ctx.params.id, ctx.query || {}); }
async function exportInterviewOrder(ctx) { await asRecruiter(ctx); return recruitment.exportInterviewOrder(ctx.params.id, ctx.query || {}); }
async function publishResults(ctx) { asSuper(ctx); return recruitment.publishResults(ctx.params.id, ctx.body || {}); }
async function archiveBatch(ctx) { asSuper(ctx); return recruitment.archiveBatch(ctx.params.id, ctx.body || {}); }
async function applications(ctx) { await asRecruiter(ctx); return recruitment.applications(ctx.query || {}); }
async function applicationDetail(ctx) { await asRecruiter(ctx); return recruitment.applicationDetail(ctx.params.id); }
async function review(ctx) { await asRecruiter(ctx); return recruitment.review(ctx.params.id, ctx.body || {}); }
async function interview(ctx) { await asRecruiter(ctx); return recruitment.interview(ctx.params.id, ctx.body || {}); }
module.exports = { batches, createBatch, batchDetail, updateBatch, publishBatch, closeBatch, deleteBatch, interviewPlan,
  generateInterviewOrder, interviewOrder,
  exportInterviewOrder, publishResults, archiveBatch, applications, applicationDetail, review, interview };
