/**
 * PM2 进程守护配置
 * 使用: pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name: 'radio-backend',
      script: 'src/app.js',
      instances: process.env.PM2_INSTANCES || '1',
      exec_mode: process.env.PM2_EXEC_MODE || 'fork',
      // 仅生产环境自动重启
      autorestart: true,
      // 崩溃后最多重启 10 次
      max_restarts: 10,
      // 内存超过 400M 自动重启，防内存泄漏
      max_memory_restart: '400M',
      // 监听文件变化自动 reload（生产可关闭）
      watch: process.env.NODE_ENV !== 'production',
      // 日志
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
      // 环境变量
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
