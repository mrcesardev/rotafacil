'use strict';
/**
 * Acesso ao PostgreSQL + migrações versionadas.
 *
 * Migrações: arquivos src/migrations/NNN_nome.sql, aplicados em ordem, cada um
 * dentro de uma transação, registrados em schema_migrations. Um advisory lock
 * impede dois servidores de migrarem ao mesmo tempo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

// "date" volta como texto 'YYYY-MM-DD' (dia no fuso da organização), sem conversão de fuso
types.setTypeParser(1082, (v) => v);
// bigint (ids, contagens) cabe com folga em Number
types.setTypeParser(20, (v) => Number(v));

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_URL = 'postgres://rotafacil:rotafacil@localhost:5432/rotafacil';

function createDb({ connectionString = process.env.DATABASE_URL || DEFAULT_URL, schema } = {}) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE || 10),
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });

  const db = {
    pool,
    query: (sql, params) => pool.query(sql, params),
    async one(sql, params) { return (await pool.query(sql, params)).rows[0] || null; },
    async many(sql, params) { return (await pool.query(sql, params)).rows; },
    /** Executa fn(q) numa transação; q tem query/one/many ligados ao mesmo cliente. */
    async tx(fn) {
      const client = await pool.connect();
      const q = {
        query: (sql, params) => client.query(sql, params),
        one: async (sql, params) => (await client.query(sql, params)).rows[0] || null,
        many: async (sql, params) => (await client.query(sql, params)).rows,
      };
      try {
        await client.query('BEGIN');
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

async function migrate(db, { log = console.log } = {}) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of files) {
      const version = parseInt(file, 10);
      if (done.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
        await client.query('COMMIT');
        log(`[db] migração aplicada: ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${file}: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

module.exports = { createDb, migrate };
