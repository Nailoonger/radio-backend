// 直接 import 后端的 models，模拟 controller 流程
const { Member } = require('/app/src/models');
const sequelize = require('/app/src/config/database');

(async () => {
  try {
    const m = await Member.create({
      name: '调试-播音-controller',
      role: '主播',
      department: '播音部',
      grade: '高一',
      avatar: '/test.jpg',
      isShow: 1,
    });
    console.log('Member.create ok id=' + m.id);
    const [rows] = await sequelize.query(
      'SELECT id, name, HEX(department) AS h, department FROM member WHERE id = ?', 
      { replacements: [m.id] }
    );
    console.log('rows:', JSON.stringify(rows));
    process.exit(0);
  } catch (e) { console.error('ERR:', e.message); process.exit(1); }
})();
