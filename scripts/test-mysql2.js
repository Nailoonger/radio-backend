// 测 mysql2 直连 + utf8mb4
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: 'mysql', port: 3306, user: 'root', password: 'root123',
      database: 'radio_station', charset: 'utf8mb4'
    });
    console.log('1. conn.config.charset =', conn.config.charset);
    console.log('1b. conn.config.charsetNumber =', conn.config.charsetNumber);

    const [v] = await conn.query(
      'SHOW VARIABLES WHERE Variable_name IN (?, ?, ?)',
      ['character_set_client', 'character_set_connection', 'character_set_results']
    );
    console.log('2. charset vars:', v);

    const [r] = await conn.query(
      'INSERT INTO member (name, role, department, grade, avatar) VALUES (?, ?, ?, ?, ?)',
      ['中文测试A', '测试', '播音部', '高一1班', '/test.jpg']
    );
    console.log('3. insertId =', r.insertId);

    const [rows] = await conn.query(
      'SELECT id, name, HEX(department), department FROM member WHERE name = ?',
      ['中文测试A']
    );
    console.log('4. rows =', rows);

    await conn.query('DELETE FROM member WHERE name = ?', ['中文测试A']);
    await conn.end();
    console.log('5. done');
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
  }
})();