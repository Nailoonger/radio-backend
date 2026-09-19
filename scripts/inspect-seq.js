const { Sequelize } = require('sequelize');
const sequelize = new Sequelize('radio_station', 'root', 'root123', {
  host: 'mysql', port: 3306, dialect: 'mysql', logging: console.log,
});
(async () => {
  try {
    await sequelize.authenticate();
    const [v] = await sequelize.query("SHOW VARIABLES WHERE Variable_name IN ('character_set_client','character_set_connection','character_set_results')");
    console.log('VARS:', JSON.stringify(v));
    process.exit(0);
  } catch (e) { console.error('ERR:', e.message); process.exit(1); }
})();
