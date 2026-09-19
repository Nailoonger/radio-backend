// 完全 Node.js 客户端发请求，不经 bash 转义
const http = require('http');

function req(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // 1. 登录
  const loginBody = JSON.stringify({ username: 'teacher', password: 'admin123456' });
  const login = await req({
    host: '127.0.0.1', port: 80, path: '/api/admin/login', method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(loginBody) }
  }, loginBody);
  const loginData = JSON.parse(login.body);
  const token = loginData.data?.token;
  console.log('Token len:', token?.length);

  // 2. 创建成员（用 UTF-8 编码的字符串）
  const body = JSON.stringify({
    name: '调试-纯净',
    role: '主播',
    department: '播音部',
    grade: '高一1班',
    avatar: '/test.jpg',
  });
  console.log('发送 body 字节 (hex 前 200):', Buffer.from(body, 'utf8').toString('hex').slice(0, 200));
  console.log('department 字节:', Buffer.from('播音部', 'utf8').toString('hex'));

  const create = await req({
    host: '127.0.0.1', port: 80, path: '/api/admin/member/create', method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': 'Bearer ' + token,
      'Content-Length': Buffer.byteLength(body),
    }
  }, body);
  console.log('Create response:', create.body.slice(0, 200));
  process.exit(0);
})();
