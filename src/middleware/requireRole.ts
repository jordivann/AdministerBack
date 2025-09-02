// src/middleware/requireRole.ts
import { Request, Response, NextFunction } from 'express';
import { PoolClient } from 'pg';
import { withUser } from '../db';
import { AuthedRequest } from './auth';

export function requireRole(roleName: string) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const ok = await withUser(req.user!.id, async (c: PoolClient) => {
        const { rows } = await c.query(
          `select 1
             from app.user_roles ur
             join app.roles r on r.id = ur.role_id
            where ur.user_id = $1 and r.name = $2
            limit 1`,
          [req.user!.id, roleName]
        );
        return rows.length > 0;
      });
      if (!ok) return res.status(403).json({ error: 'forbidden (role required)' });
      next();
    } catch (e) {
      return res.status(500).json({ error: 'authz error' });
    }
  };
}
