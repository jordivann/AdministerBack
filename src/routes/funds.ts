// src/routes/funds.ts
import { Router } from 'express';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';

const router = Router();

// GET /funds → solo fondos visibles para el usuario
router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const rows = await withUser(userId, async (c) => {
    const q = await c.query(
      `select f.id, f.name, f.is_active
         from app.funds f
         join app.v_effective_fund_access efa
           on efa.fund_id = f.id
        where efa.user_id = $1
        group by f.id, f.name, f.is_active
        order by f.name`,
      [userId]
    );
    return q.rows;
  });
  res.json(rows);
});

export default router;
