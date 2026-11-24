'use strict';
/**
 * Banco de teste: cada execução cria um schema próprio no PostgreSQL apontado
 * por TEST_DATABASE_URL (ou DATABASE_URL) e apaga no final.
 */
const crypto = require('node:crypto');
const { createDb, migrate } = require('../src/db');

async function createTestDb() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://rotafacil:rotafacil@localhost:5432/rotafacil';
  const schema = `test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = createDb({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const db = createDb({ connectionString: url, schema });
  await migrate(db, { log: () => {} });
  db.drop = async () => {
    await db.close();
    const a = createDb({ connectionString: url });
    await a.query(`DROP SCHEMA ${schema} CASCADE`);
    await a.close();
  };
  return db;
}

module.exports = { createTestDb };
