import { Router } from 'express';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';

const router = Router();

// GET /categories  -> [{ id, name }]
router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const rows = await withUser(userId, async (c) => {
    const q = await c.query(`select id, name from app.categories order by name`);
    return q.rows;
  });
  res.json(rows);
});

export default router;
