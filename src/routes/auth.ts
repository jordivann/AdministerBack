// src/routes/auth.ts (versión bcrypt)
import { Router } from 'express';
import { z } from 'zod';
import jwt, { SignOptions, Secret } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { withConn } from '../db'; // ../db.ts si usás ESM+tsx

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function expSeconds(raw: string | undefined, def = 3600) {
  if (!raw) return def;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return def;
  const n = Number(m[1]);
  const mult = m[2].toLowerCase() === 's' ? 1 : m[2].toLowerCase() === 'm' ? 60 : m[2].toLowerCase() === 'h' ? 3600 : 86400;
  return n * mult;
}

router.post('/login', async (req, res) => {
  const p = LoginSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid payload' });
  const { email, password } = p.data;

  try {
    const user = await withConn(async (c) => {
      const q = await c.query<{ id: string; email: string; full_name: string | null; password_hash: string | null; is_active: boolean }>(
        `select id, email, full_name, password_hash, is_active
           from app.users
          where email = $1`,
        [email]
      );
      return q.rows[0];
    });

    if (!user || !user.is_active || !user.password_hash) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    if (!process.env.JWT_SECRET) {
      console.error('[login] missing JWT_SECRET');
      return res.status(500).json({ error: 'server misconfigured: JWT_SECRET' });
    }

    const token = jwt.sign(
      { sub: user.id },
      process.env.JWT_SECRET as Secret,
      {
        algorithm: 'HS256',
        issuer: process.env.JWT_ISS,
        audience: process.env.JWT_AUD,
        expiresIn: expSeconds(process.env.JWT_EXPIRES_IN, 3600),
      } as SignOptions
    );

    return res.json({
      token,
      user: { id: user.id, email: user.email, full_name: user.full_name },
    });
  } catch (e) {
    console.error('[login] error', e);
    return res.status(500).json({ error: 'login failed' });
  }
});

export default router;
