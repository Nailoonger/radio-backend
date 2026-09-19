'use strict';

/**
 * song_quota —— 点歌名额计数器（按「日」和「周」各一行）
 *
 * 为什么单独建表而不是每次 COUNT(*)：
 *   1. COUNT(status=1 AND create_time 在当天) 是**扫描**，并发放大时会越来越慢；
 *   2. 更致命的是它没法原子「占位」—— 两个管理员同时通过，先查后写必然超发。
 *      （本项目允许空 openid 点歌，`REPEATABLE READ` 下快照读也拦不住超发）
 *
 * 关键约束：UNIQUE(period, period_key)
 *   靠它把「拿到本周期那一行」变成一次 INSERT 冲突即可确定的操作，
 *   并发下只有一个请求能建成行，其它请求走 findOrCreate 的冲突重试分支。
 *
 * used 只允许用「单条带条件的 UPDATE」自增（见 services/songQuotaService.js），
 * 任何地方都不允许 SELECT used 之后再写回。
 */
module.exports = (sequelize, DataTypes) => {
  const SongQuota = sequelize.define(
    'songQuota',
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
      period: {
        type: DataTypes.TINYINT,
        allowNull: false,
        comment: '1=日 2=周',
      },
      periodKey: {
        type: DataTypes.STRING(10),
        allowNull: false,
        field: 'period_key',
        comment: '日=2026-09-18；周=2026-W38（ISO 周，周一起）',
      },
      used: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '本周期已通过的点歌数，原子自增',
      },
      exhaustedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'exhausted_at',
        comment: '名额用尽时刻，仅用于展示与排查',
      },
      createTime: { type: DataTypes.DATE, field: 'create_time', defaultValue: DataTypes.NOW },
      updateTime: { type: DataTypes.DATE, field: 'update_time', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'song_quota',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        // 并发正确性的地基：本周期只有一行
        { name: 'uk_period_key', unique: true, fields: ['period', 'period_key'] },
      ],
    }
  );
  return SongQuota;
};
