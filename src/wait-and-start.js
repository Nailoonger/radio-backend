/**
 * 启动脚本：等 MySQL TCP 通 → 启动 Node
 * 解决 Dockerfile 里 CMD 数组形式被 Windows Node 路径解析干扰的问题
 */
const net = require('net');

const host = process.env.DB_HOST || 'mysql';
const port = parseInt(process.env.DB_PORT || '3306', 10);
const TIMEOUT = 30; // 秒

function checkTcp() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.end(); resolve(true); });
    socket.once('error', () => socket.destroy());
    socket.once('timeout', () => socket.destroy());
  });
}

async function waitForMysql() {
  console.log(`[wait] 等待 MySQL ${host}:${port} ...`);
  for (let i = 1; i <= TIMEOUT; i++) {
    if (await checkTcp()) {
      console.log(`[wait] ✅ MySQL 就绪（用时 ${i}s）`);
      await new Promise(r => setTimeout(r, 3000)); // 让 initdb 完成
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`[wait] MySQL ${host}:${port} 在 ${TIMEOUT}s 内未就绪`);
}

(async () => {
  try {
    await waitForMysql();
    console.log('[boot] 启动 Node...');
    require('./app.js');
  } catch (e) {
    console.error('[boot] 启动失败:', e.message);
    process.exit(1);
  }
})();