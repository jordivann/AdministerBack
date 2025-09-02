// src/db.ts
import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
import { parse } from 'pg-connection-string';

// Parseamos la DATABASE_URL y armamos config explícito + SSL no verificado
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL no está definido en .env');

const cfg = parse(url);
function req<T extends string | null | undefined>(v: T, name: string): string {
  if (!v) throw new Error(`DATABASE_URL inválida: falta ${name}`);
  return String(v);
}

export const pool = new Pool({
  host: req(cfg.host, 'host'),
  port: Number(cfg.port ?? '5432'),
  database: req(cfg.database, 'database'),
  user: req(cfg.user, 'user'),
  password: req(cfg.password, 'password'),
  ssl: { rejectUnauthorized: false }, // 👈 clave para pooler Supabase (self-signed)
});

export async function withConn<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

export async function withUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select app.set_current_user($1)', [userId]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
