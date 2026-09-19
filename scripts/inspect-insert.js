const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize('radio_station', 'root', 'root123', {
  host: 'mysql', port: 3306, dialect: 'mysql', logging: console.log,
});
const Member = sequelize.define('member', {
  name: { type: DataTypes.STRING(32), allowNull: false },
  role: { type: DataTypes.STRING(32), allowNull: false },
  department: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
  avatar: { type: DataTypes.STRING(512), allowNull: false },
}, { tableName: 'member', timestamps: false });

(async () => {
  try {
    const m = await Member.create({
      name: '调试播音2',
      role: '主播',
      department: '播音部',
      avatar: '/test.jpg',
    });
    console.log('INSERTED id=' + m.id);
    const [rows] = await sequelize.query("SELECT id, name, HEX(department), department FROM member WHERE id = " + m.id);
    console.log('ROWS:', JSON.stringify(rows));
    process.exit(0);
  } catch (e) { console.error('ERR:', e.message); process.exit(1); }
})();
