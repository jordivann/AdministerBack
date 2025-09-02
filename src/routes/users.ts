// src/routes/users.ts
import { Router } from 'express';
import { AuthedRequest} from '../middleware/auth.js';
import { withUser } from '../db.js';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

const CreateUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  password: z.string().min(6),
  role: z.string().min(1), // 'Los pipinos' | 'La Rioja' |  'admin' | 'user'
  is_active: z.boolean().optional().default(true),
});

router.post('/', requireRole('admin'), async (req: AuthedRequest, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' });
  const { email, full_name, password, role, is_active } = parsed.data;

  try {
    const hash = bcrypt.hashSync(password, 10);
    const out = await withUser(req.user!.id, async (c) => {
      // crear usuario (idempotente por email)
      const u = await c.query(
        `insert into app.users (email, password_hash, full_name, is_active)
         values ($1,$2,$3,$4)
         on conflict (email) do update set
           password_hash = excluded.password_hash,
           full_name = excluded.full_name,
           is_active = excluded.is_active
         returning id, email`,
        [email, hash, full_name, is_active]
      );

      // vincular rol
      const r = await c.query<{id:string}>('select id from app.roles where name=$1', [role]);
      if (!r.rowCount) throw new Error(`role not found: ${role}`);
      await c.query(
        `insert into app.user_roles (user_id, role_id)
         values ($1,$2)
         on conflict (user_id, role_id) do nothing`,
        [u.rows[0].id, r.rows[0].id]
      );

      return u.rows[0];
    });

    res.status(201).json({ id: out.id, email: out.email });
  } catch (e:any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
