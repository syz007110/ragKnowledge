const { Sequelize } = require('sequelize');

const DB_DIALECT = process.env.DB_DIALECT || 'postgres';
const DB_HOST = process.env.PG_HOST || process.env.MYSQL_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.PG_PORT || process.env.MYSQL_PORT || (DB_DIALECT === 'postgres' ? 5432 : 3306));
const DB_NAME = process.env.PG_DATABASE || process.env.MYSQL_DATABASE;
const DB_USER = process.env.PG_USER || process.env.MYSQL_USER;
const DB_PASSWORD = process.env.PG_PASSWORD || process.env.MYSQL_PASSWORD;

const sequelize = new Sequelize(
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  {
    host: DB_HOST,
    port: DB_PORT,
    dialect: DB_DIALECT,
    logging: false
  }
);

async function testDatabaseConnection() {
  await sequelize.authenticate();
}

module.exports = {
  sequelize,
  testDatabaseConnection,
  testMySQLConnection: testDatabaseConnection
};
