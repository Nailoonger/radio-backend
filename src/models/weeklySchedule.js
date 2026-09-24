'use strict';

/**
 * 周排期（协议文档「六、weekly_schedules」）
 *
 * 一周一行，`week_start_date` 唯一 —— 同一周不可能出现两份排期。
 * 承载**周状态机**与时间锚点：
 *
 *   DRAFT ──发布──> APPLICATION ──申请截止──> REVIEW ──审核完成──> SCHEDULING ──锁定──> LOCKED
 *      └──────────────────── 取消 ────────────────────> CANCELLED
 *
 * 时间锚点全部由 KV 点歌窗口派生（`songWindowService`），本表只是**落库快照**：
 *    application_start_at / application_end_at   ← 窗口起止
 *    review_start_at                             = application_end_at
 *    schedule_lock_at                            = 窗口结束 + 偏移（默认 6h → 播出周周一 00:00）
 *
 * 为什么要有这张表（而不是继续纯派生）：
 *   ① 锁定是一次**写动作**，必须记住「这周已经锁过了」，不能靠时间反推；
 *   ② 管理员可以手动提前锁定（POST /admin/submit/weeks/:id/lock）；
 *   ③ 排期矩阵、调度记录都要挂在一个稳定的 week id 上。
 */
module.exports = (sequelize, DataTypes) => {
  const WeeklySchedule = sequelize.define(
    'weeklySchedule',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      weekStartDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        unique: true,
        field: 'week_start_date',
        comment: '该播出周的周一日期（北京时间），唯一',
      },
      applicationStartAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'application_start_at',
        comment: '申请（收歌）开始时刻',
      },
      applicationEndAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'application_end_at',
        comment: '申请截止时刻',
      },
      reviewStartAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'review_start_at',
        comment: '审核开始时刻（= 申请截止）',
      },
      reviewEndAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'review_end_at',
        comment: '审核截止时刻（= 锁定时刻）',
      },
      scheduleLockAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'schedule_lock_at',
        comment: '排期锁定时刻，到点跑最后一次调度并 AUTO_REJECTED 剩余候补',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'DRAFT',
        comment: 'DRAFT / APPLICATION / REVIEW / SCHEDULING / LOCKED / CANCELLED',
      },
      lockedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'locked_at',
        comment: '实际锁定时刻（手动提前锁会与 schedule_lock_at 不同）',
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'created_by',
        comment: 'FK admin.id；自动懒创建时为 null',
      },
      createTime: { type: DataTypes.DATE, field: 'created_at', defaultValue: DataTypes.NOW },
      updateTime: { type: DataTypes.DATE, field: 'updated_at', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'weekly_schedule',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        { name: 'idx_week_start', fields: ['week_start_date'] },
        { name: 'idx_week_status', fields: ['status'] },
      ],
    }
  );
  return WeeklySchedule;
};
