'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rotafacil.db');

function open(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      depot_address TEXT,
      depot_lat REAL,
      depot_lng REAL,
      service_minutes INTEGER NOT NULL DEFAULT 3,
      start_time TEXT NOT NULL DEFAULT '08:00',
      return_to_depot INTEGER NOT NULL DEFAULT 0,
      whatsapp_phone_number_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      max_stops INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
      driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      distance_m REAL NOT NULL DEFAULT 0,
      duration_s REAL NOT NULL DEFAULT 0,
      geometry TEXT,
      engine TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      customer_name TEXT,
      phone TEXT,
      address TEXT,
      notes TEXT,
      lat REAL,
      lng REAL,
      raw_input TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pendente',
      route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL,
      stop_order INTEGER,
      eta TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_op_date ON deliveries(operator_id, date);
    CREATE INDEX IF NOT EXISTS idx_routes_op_date ON routes(operator_id, date);
  `);

  // migrações: rotas individuais, partindo de onde cada entregador está
  addColumn(db, 'drivers', 'start_lat', 'REAL');
  addColumn(db, 'drivers', 'start_lng', 'REAL');
  addColumn(db, 'drivers', 'start_address', 'TEXT');
  addColumn(db, 'drivers', 'start_updated_at', 'TEXT');
  addColumn(db, 'deliveries', 'driver_id', 'INTEGER REFERENCES drivers(id) ON DELETE SET NULL');
  addColumn(db, 'routes', 'start_lat', 'REAL');
  addColumn(db, 'routes', 'start_lng', 'REAL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_driver_date ON routes(driver_id, date)');
  return db;
}

function addColumn(db, table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

module.exports = { open };
