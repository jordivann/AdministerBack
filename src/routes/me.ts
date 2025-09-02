import { Router } from 'express';
import { withConn } from '../db';

const router = Router();

router.get('/', async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const data = await withConn(async (c) => {
      const u = await c.query<{
        id: string; email: string; full_name: string | null; is_active: boolean; created_at: string;
      }>(
        `select id, email, full_name, is_active, created_at
           from app.users
          where id = $1`,
        [userId]
      );
      if (!u.rowCount) return null;

      const r = await c.query<{ name: string }>(
        `select r.name
           from app.user_roles ur
           join app.roles r on r.id = ur.role_id
          where ur.user_id = $1
          order by r.name`,
        [userId]
      );

      const fa = await c.query<{ fund_id: string; scope: 'read'|'write'|'admin' }>(
        `select fund_id, scope
           from app.v_effective_fund_access
          where user_id = $1
          order by fund_id`,
        [userId]
      );

      return {
        user: u.rows[0],
        roles: r.rows.map(x => x.name),
        fund_access: fa.rows,
      };
    });

    if (!data) return res.status(404).json({ error: 'user not found' });
    return res.json(data);
  } catch (e) {
    console.error('[GET /me] error', e);
    return res.status(500).json({ error: 'failed to load profile' });
  }
});

export default router;
