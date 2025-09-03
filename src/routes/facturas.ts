import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';
import { requireRole } from '../middleware/requireRole';

const router = Router();

/* =============== Schemas =============== */
const Estado = z.enum(['Pendiente','Cobrado','Baja']);

// SIEMPRE texto 'YYYY-MM-DD' para evitar TZ shift
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const QList = z.object({
  q: z.string().trim().optional(),                 // busca en numero / notas
  estado: Estado.optional(),
  fund_id: z.string().uuid().optional(),
  // si más adelante querés filtros por fecha: from/to como DateStr
  // from: DateStr.optional(),
  // to: DateStr.optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// FECHAS como string plano 'YYYY-MM-DD' (sin T, sin Z)
const CreateBody = z.object({
  fund_id: z.string().uuid(),
  client_id: z.string().uuid(),       // ⬅️ requerido
  numero: z.string().trim().min(1, 'número requerido'),
  fecha_emision: DateStr,             // <- string
  fecha_vencimiento: DateStr.nullable().optional(), // <- string o null
  monto_total: z.coerce.number().nonnegative(),
  pdf_url: z.string().url().nullable().optional(),
  estado: Estado.default('Pendiente'),
  notas: z.string().trim().nullable().optional(),
});

const EstadoBody = z.object({
  estado: z.enum(['Pendiente', 'Cobrado', 'Baja']),
});

// PATCH parcial
const PatchBody = CreateBody.partial();

/* =============== Listar (logueados) =============== */
router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });

  const Q = z.object({
    q: z.string().trim().optional(),
    estado: z.enum(['Pendiente', 'Cobrado', 'Baja']).optional(),
    fund_id: z.string().uuid().optional(),
    client_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(1000).default(200),
    offset: z.coerce.number().int().nonnegative().default(0),
  });
  const parsed = Q.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { q, estado, fund_id, client_id, limit, offset } = parsed.data;

  const params: any[] = [userId];
  const wh: string[] = [];
  const add = (sql: string, v: any) => { params.push(v); wh.push(sql.replace('$$', `$${params.length}`)); };

  if (estado)  add('f.estado = $$', estado);
  if (fund_id) add('f.fund_id = $$', fund_id);
  if (client_id) add('f.client_id = $$', client_id);

  // texto libre: busca por número de factura o nombre del cliente
  let qClause = '';
  if (q && q.length) {
    params.push(`%${q}%`, `%${q}%`);
    const a = params.length - 1;
    const b = params.length;
    qClause = ` and (f.numero ilike $${a} or c.name ilike $${b})`;
  }

  const sql = `
    with me as (
      select exists(
        select 1
          from app.user_roles ur
          join app.roles r on r.id = ur.role_id
         where ur.user_id = $1
           and lower(r.name) in ('admin','owner')
      ) as is_admin
    ),
    allowed_funds as (
      select distinct rfa.fund_id
        from app.user_roles ur
        join app.role_fund_access rfa on rfa.role_id = ur.role_id
       where ur.user_id = $1
         and rfa.scope in ('read','write','admin')
    )
    select
      f.id,
      f.fund_id,
      f.client_id,
      c.name as client_name,
      f.numero,
      to_char(f.fecha_emision::date,     'YYYY-MM-DD') as fecha_emision,
      to_char(f.fecha_vencimiento::date, 'YYYY-MM-DD') as fecha_vencimiento,
      f.monto_total,
      round((f.monto_total / 1.21)::numeric, 2) as neto,
      round((f.monto_total - (f.monto_total / 1.21))::numeric, 2) as iva,
      f.pdf_url,
      f.estado,
      f.notas,
      to_char(f.created_at::date, 'YYYY-MM-DD') as created_at,
      to_char(f.updated_at::date, 'YYYY-MM-DD') as updated_at
    from app.facturas f
    left join app.clients c on c.id = f.client_id
    , me
    where (me.is_admin or f.fund_id in (select fund_id from allowed_funds))
      ${wh.length ? 'and ' + wh.join(' and ') : ''}
      ${qClause}
    order by f.fecha_emision desc, f.created_at desc
    limit ${limit} offset ${offset}
  `;

  const rows = await withUser(userId, (c) => c.query(sql, params).then(r => r.rows));
  res.json(rows);
});

router.get('/:id', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  const { id } = req.params;

  const sql = `
    with me as (
      select exists(
        select 1
          from app.user_roles ur
          join app.roles r on r.id = ur.role_id
         where ur.user_id = $2
           and lower(r.name) in ('admin','owner')
      ) as is_admin
    ),
    allowed_funds as (
      select distinct rfa.fund_id
        from app.user_roles ur
        join app.role_fund_access rfa on rfa.role_id = ur.role_id
       where ur.user_id = $2
         and rfa.scope in ('read','write','admin')
    )
    select json_build_object(
      'id',               f.id,
      'fund_id',          f.fund_id,
      'client_id',        f.client_id,
      'client_name',      c.name,
      'numero',           f.numero,
      'fecha_emision',     to_char(f.fecha_emision::date,     'YYYY-MM-DD'),
      'fecha_vencimiento', to_char(f.fecha_vencimiento::date, 'YYYY-MM-DD'),
      'monto_total',      f.monto_total,           -- opcional: ::float8
      'neto',             round((f.monto_total / 1.21)::numeric, 2),
      'iva',              round((f.monto_total - (f.monto_total / 1.21))::numeric, 2),
      'pdf_url',          f.pdf_url,
      'estado',           f.estado,
      'notas',            f.notas,
      'created_at',       to_char(f.created_at::date, 'YYYY-MM-DD'),
      'updated_at',       to_char(f.updated_at::date, 'YYYY-MM-DD')
    ) as factura

    from app.facturas f
    left join app.clients c on c.id = f.client_id
    , me
    where f.id = $1
      and (me.is_admin or f.fund_id in (select fund_id from allowed_funds))
    limit 1
  `;

  const row = await withUser(userId, (c) => c.query(sql, [id, userId]).then(r => r.rows[0]));
  if (!row) return res.status(404).json({ error: 'No encontrada o sin permiso' });
  res.json(row.factura);
});

/* =============== Crear (admin) =============== */
router.post('/', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  const { rows } = await withUser(userId, (c) =>
    c.query(
      `insert into app.facturas
       (fund_id, client_id, numero, fecha_emision, fecha_vencimiento, monto_total, pdf_url, estado, notas)
       values ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9)
       returning id`,
      [
        p.fund_id,
        p.client_id ?? null,
        p.numero,
        p.fecha_emision,                   // string 'YYYY-MM-DD'
        p.fecha_vencimiento ?? null,       // string 'YYYY-MM-DD' o null
        p.monto_total,
        p.pdf_url ?? null,
        p.estado,
        p.notas ?? null,
      ]
    )
  );

  res.status(201).json({ id: rows[0].id });
});

/* =============== Editar (admin) =============== */
router.patch('/:id', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const pushDate = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}::date`); };

  if (p.fund_id !== undefined)           push('fund_id', p.fund_id);
  if (p.client_id !== undefined)         push('client_id', p.client_id ?? null);
  if (p.numero !== undefined)            push('numero', p.numero);
  if (p.fecha_emision !== undefined)     pushDate('fecha_emision', p.fecha_emision);               // ::date
  if (p.fecha_vencimiento !== undefined) pushDate('fecha_vencimiento', p.fecha_vencimiento ?? null); // ::date
  if (p.monto_total !== undefined)       push('monto_total', p.monto_total);
  if (p.pdf_url !== undefined)           push('pdf_url', p.pdf_url ?? null);
  if (p.estado !== undefined)            push('estado', p.estado);
  if (p.notas !== undefined)             push('notas', p.notas ?? null);

  if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });

  vals.push(id);
  const row = await withUser(userId, (c) =>
    c.query(`update app.facturas set ${sets.join(', ')}, updated_at = now() where id = $${vals.length} returning id`, vals)
      .then(r => r.rows[0])
  );
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json({ id: row.id, updated: true });
});

/* =============== Borrar (admin, opcional) =============== */
router.delete('/:id', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const row = await withUser(userId, (c) =>
    c.query('delete from app.facturas where id = $1 returning id', [id]).then(r => r.rows[0])
  );
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json({ id: row.id, deleted: true });
});

router.patch('/:id/estado', requireRole('admin'), async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const parsed = EstadoBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const row = await withUser(userId, (c) =>
    c.query(
      `update app.facturas
          set estado = $1,
              updated_at = now()
        where id = $2
        returning id, estado`,
      [parsed.data.estado, id]
    ).then(r => r.rows[0])
  );

  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json(row);
});

export default router;
