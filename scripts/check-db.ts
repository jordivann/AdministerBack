// scripts/check-db.ts
import 'dotenv/config';
import { Client } from 'pg';
import { parse } from 'pg-connection-string';

function ensure(v: string | null | undefined, name: string): string {
  if (!v) throw new Error(`DATABASE_URL inválida: falta ${name}`);
  return v;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL no está definido en .env');

  // Parseamos la URL y validamos campos obligatorios
  const cfg = parse(url);
  const host = ensure(cfg.host, 'host');
  const database = ensure(cfg.database, 'database');
  const user = ensure(cfg.user, 'user');
  const password = ensure(cfg.password, 'password');
  const port = Number(cfg.port ?? '5432');

  // Forzamos SSL sin validar CA (requerido con pooler IPv4 de Supabase)
  const client = new Client({
    host,
    port,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const res = await client.query(
      'select current_user, current_database(), inet_server_addr() as server_ip',
    );
    console.log('✅ Conectado:', res.rows[0]);
  } catch (err) {
    console.error('❌ Error de conexión:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
