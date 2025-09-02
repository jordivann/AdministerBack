// src/routes/providers.ts
import { Router } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';
import { requireRole } from '../middleware/requireRole';

const router = Router();

const UpsertBody = z.object({
  name: z.string().trim().min(1, 'name requerido'),
  email: z.string().email().nullable().optional(),
  cuit: z.string().trim().nullable().optional(),
  cbu: z.string().trim().nullable().optional(),
  Alias: z.string().trim().nullable().optional(),      // 👈 mayúscula tal cual en DB
  aclaracion: z.string().trim().nullable().optional(),
  codIdioma: z.string().trim().nullable().optional(),  // 👈 camel tal cual en DB
  banco: z.string().trim().nullable().optional(),
});

/**
 * GET /providers
 * Sin requireRole — cualquier usuario logueado puede ver.
 */
router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });

  const rows = await withUser(userId, async (c) => {
    const q = await c.query(`
      select id, name, email, cuit, cbu,
             "Alias"      as "Alias",
             aclaracion,
             "codIdioma"  as "codIdioma",
             banco
        from app.providers
       order by name
    `);
    return q.rows;
  });

  res.json(rows);
});

/**
 * POST /providers
 * Crear proveedor — solo admin.
 */
router.post('/', requireRole('admin'), async (req: AuthedRequest, res) => {
  const userId = req.user!.id;

  const parsed = UpsertBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  const row = await withUser(userId, async (c) => {
    const { rows } = await c.query(
      `insert into app.providers
         (name, email, cuit, cbu, "Alias", aclaracion, "codIdioma", banco)
       values
         ($1,   $2,    $3,   $4,  $5,      $6,         $7,         $8)
       returning id`,
      [p.name, p.email ?? null, p.cuit ?? null, p.cbu ?? null, p.Alias ?? null, p.aclaracion ?? null, p.codIdioma ?? null, p.banco ?? null]
    );
    return rows[0];
  });

  res.status(201).json({ id: row.id });
});

/**
 * PATCH /providers/:id
 * Editar proveedor — solo admin.
 */
router.patch('/:id', requireRole('admin'), async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const parsed = UpsertBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  if (p.name !== undefined)       push('name', p.name);
  if (p.email !== undefined)      push('email', p.email ?? null);
  if (p.cuit !== undefined)       push('cuit', p.cuit ?? null);
  if (p.cbu !== undefined)        push('cbu', p.cbu ?? null);
  if (p.Alias !== undefined)      push('"Alias"', p.Alias ?? null);       // 👈 comillas
  if (p.aclaracion !== undefined) push('aclaracion', p.aclaracion ?? null);
  if (p.codIdioma !== undefined)  push('"codIdioma"', p.codIdioma ?? null); // 👈 comillas
  if (p.banco !== undefined)      push('banco', p.banco ?? null);

  if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });

  vals.push(id);
  const row = await withUser(userId, async (c) => {
    const { rows } = await c.query(
      `update app.providers set ${sets.join(', ')} where id = $${vals.length} returning id`,
      vals
    );
    return rows[0];
  });

  if (!row) return res.status(404).json({ error: 'No encontrado' });
  res.json({ id: row.id, updated: true });
});

export default router;
