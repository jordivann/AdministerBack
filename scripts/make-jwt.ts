// scripts/make-jwt.ts
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { withConn } from '../src/db';

async function main() {
  const email = process.argv[2] || 'admin@example.com';
  const { id } = await withConn(async (c) => {
    const q = await c.query<{ id: string }>('select id from app.users where email=$1', [email]);
    if (!q.rowCount) throw new Error(`no user with email ${email}`);
    return q.rows[0];
  });

  const token = jwt.sign({ sub: id }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '12h' });
  console.log(token);
}
main().catch((e) => { console.error(e); process.exit(1); });
