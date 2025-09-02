// src/routes/cuentas_los_pipinos.ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';
import { requireRole } from '../middleware/requireRole';

const router = Router();

/* ========= Schemas ========= */
const QList = z.object({
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const CreateBody = z.object({
  name: z.string().min(1, 'name requerido'),
  monto: z.coerce.number().default(0),
  pdf_url: z.string().url().optional().or(z.literal('')).default(''), // valida URL si viene
});

const PatchBody = z.object({
  name: z.string().min(1).optional(),
  monto: z.coerce.number().optional(),
  pdf_url: z.string().url().optional().or(z.literal('')), // permitir vacío para “borrar”
});

/* ========= Rutas ========= */

/** GET /cuentas-lospipinos */
router.get('/', async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id!;
  const parsed = QList.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { q, limit, offset } = parsed.data;

  const where: string[] = [];
  const params: any[] = [];
  const add = (sql: string, v: any) => {
    params.push(v);
    where.push(sql.replace('$$', `$${params.length}`));
  };

  if (q) add('name ILIKE $$', `%${q}%`);

  const sql = `
    select id, name, monto, fecha_actualizacion, pdf_url
      from app.cuentas_los_pipinos
     ${where.length ? 'where ' + where.join(' and ') : ''}
     order by fecha_actualizacion desc
     limit ${limit} offset ${offset}
  `;

  const rows = await withUser(userId, (c) => c.query(sql, params).then(r => r.rows));
  res.json(rows);
});

/** POST /cuentas-lospipinos */
router.post('/', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id!;
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, monto, pdf_url } = parsed.data;

  const row = await withUser(userId, async (c) => {
    const { rows } = await c.query(
      `insert into app.cuentas_los_pipinos (name, monto, pdf_url)
       values ($1, $2, nullif($3, ''))
       returning id, name, monto, fecha_actualizacion, pdf_url`,
      [name.trim(), Number(monto), pdf_url ?? '']
    );
    return rows[0];
  });

  res.status(201).json(row);
});

/** PATCH /cuentas-lospipinos/:id */
router.patch('/:id', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id!;
  const { id } = req.params;

  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const sets: string[] = [];
  const params: any[] = [];
  const addSet = (k: string, v: any) => { params.push(v); sets.push(`${k} = $${params.length}`); };

  if (typeof parsed.data.name !== 'undefined') addSet('name', parsed.data.name.trim());
  if (typeof parsed.data.monto !== 'undefined') addSet('monto', Number(parsed.data.monto));
  if (typeof parsed.data.pdf_url !== 'undefined') addSet('pdf_url', parsed.data.pdf_url ? parsed.data.pdf_url : null);

  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

  params.push(id);
  const sql = `
    update app.cuentas_los_pipinos
       set ${sets.join(', ')}
     where id = $${params.length}
     returning id, name, monto, fecha_actualizacion, pdf_url
  `;

  const row = await withUser(userId, (c) => c.query(sql, params).then(r => r.rows[0]));
  if (!row) return res.status(404).json({ error: 'No encontrada' });

  res.json(row);
});

/** POST /cuentas-lospipinos/:id/touch */
router.post('/:id/touch', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id!;
  const { id } = req.params;

  const row = await withUser(userId, async (c) => {
    const { rows } = await c.query(
      `update app.cuentas_los_pipinos
          set fecha_actualizacion = now()
        where id = $1
        returning id, name, monto, fecha_actualizacion, pdf_url`,
      [id]
    );
    return rows[0];
  });

  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json(row);
});

export default router;
