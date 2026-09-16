'use strict';

/**
 * 极简日志工具，避免引入 winston 这种重型依赖
 * 校园项目够用，生产可替换为 pino/winston
 */
const colors = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[90m',
  reset: '\x1b[0m',
};

function ts() {
  return new Date().toISOString();
}

function fmt(level, color, args) {
  // eslint-disable-next-line no-console
  console.log(`${colors[color]}[${ts()}] [${level}]${colors.reset}`, ...args);
}

module.exports = {
  info: (...args) => fmt('INFO', 'info', args),
  warn: (...args) => fmt('WARN', 'warn', args),
  error: (...args) => fmt('ERROR', 'error', args),
  debug: (...args) => {
    if (process.env.NODE_ENV === 'development') {
      fmt('DEBUG', 'debug', args);
    }
  },
};