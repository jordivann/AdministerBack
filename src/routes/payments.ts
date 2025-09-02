// src/routes/payments.ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';
import { requireRole } from '../middleware/requireRole';

const router = Router();

/* =============== Schemas =============== */
/** Estados alineados a app.payment_status */
const Estado = z.enum(['Pendiente', 'Parcial', 'Pagada', 'Cancelada']);

const QList = z.object({
  q: z.string().trim().optional(),                 // busca en num_fc / detalle / cliente
  estado: Estado.optional(),
  fund_id: z.string().uuid().optional(),
  provider_id: z.string().uuid().optional(),
  from: z.coerce.date().optional(),                // fecha_emision >= from
  to: z.coerce.date().optional(),                  // fecha_emision <  to + 1
  vto_from: z.coerce.date().optional(),            // fecha_vencimiento >= vto_from
  vto_to: z.coerce.date().optional(),              // fecha_vencimiento <  vto_to + 1
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const CreateBody = z.object({
  fund_id: z.string().uuid(),
  provider_id: z.string().uuid(),
  num_fc: z.string().trim().optional(),            // referencia rápida a nro de factura
  factura_id: z.string().uuid().nullable().optional(),
  detalle: z.string().trim().nullable().optional(),
  fecha_emision: z.coerce.date().default(new Date()),
  fecha_vencimiento: z.coerce.date().nullable().optional(),
  monto_total: z.coerce.number().nonnegative(),
  // monto_pagado lo maneja el sistema/triggers (si querés permitirlo, exponer aquí con default 0)
  metodo_pago: z.string().trim().nullable().optional(),
  comprobante_url: z.string().url().nullable().optional(),
  estado: Estado.default('Pendiente'),             // el trigger puede recalcular
  notas: z.string().trim().nullable().optional(),
});

const EstadoBody = z.object({
  estado: Estado,
});

// PATCH parcial
const PatchBody = CreateBody.partial();

/* =============== Listar (logueados) =============== */
router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });

  const parsed = QList.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { q, estado, fund_id, provider_id, from, to, vto_from, vto_to, limit, offset } = parsed.data;

  const params: any[] = [userId];
  const wh: string[] = [];
  const add = (sql: string, v: any) => { params.push(v); wh.push(sql.replace('$$', `$${params.length}`)); };

  if (estado)     add('p.estado = $$', estado);
  if (fund_id)    add('p.fund_id = $$', fund_id);
  if (provider_id)  add('p.provider_id = $$', provider_id);
  if (from)       add('p.fecha_emision >= $$', from);
  if (to)         add('p.fecha_emision < $$', new Date(to.getTime() + 24*60*60*1000)); // to + 1
  if (vto_from)   add('p.fecha_vencimiento >= $$', vto_from);
  if (vto_to)     add('p.fecha_vencimiento < $$', new Date(vto_to.getTime() + 24*60*60*1000)); // vto_to + 1

  // texto libre: busca por num_fc, detalle o nombre del cliente
  let qClause = '';
  if (q && q.length) {
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    const a = params.length - 2;
    const b = params.length - 1;
    const c = params.length;
    qClause = ` and (p.num_fc ilike $${a} or p.detalle ilike $${b} or c.name ilike $${c})`;
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
      p.id,
      p.fund_id,
      p.provider_id,
      c.name as client_name,
      p.factura_id,
      p.num_fc,
      p.detalle,
      p.fecha_emision,
      p.fecha_vencimiento,
      p.fecha_pago,
      p.monto_total,
      p.monto_pagado,
      p.saldo_pendiente,
      p.metodo_pago,
      p.comprobante_url,
      p.estado,
      p.notas,
      p.created_at,
      p.updated_at
    from app.payments p
    left join app.clients c on c.id = p.provider_id
    , me
    where (me.is_admin or p.fund_id in (select fund_id from allowed_funds))
      ${wh.length ? 'and ' + wh.join(' and ') : ''}
      ${qClause}
    order by coalesce(p.fecha_vencimiento, p.fecha_emision) asc, p.created_at desc
    limit ${limit} offset ${offset}
  `;

  const rows = await withUser(userId, (c) => c.query(sql, params).then(r => r.rows));
  res.json(rows);
});

/* =============== Obtener 1 (logueados) =============== */
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
      'id', p.id,
      'fund_id', p.fund_id,
      'provider_id', p.provider_id,
      'client_name', c.name,
      'factura_id', p.factura_id,
      'num_fc', p.num_fc,
      'detalle', p.detalle,
      'fecha_emision', p.fecha_emision,
      'fecha_vencimiento', p.fecha_vencimiento,
      'fecha_pago', p.fecha_pago,
      'monto_total', p.monto_total,
      'monto_pagado', p.monto_pagado,
      'saldo_pendiente', p.saldo_pendiente,
      'metodo_pago', p.metodo_pago,
      'comprobante_url', p.comprobante_url,
      'estado', p.estado,
      'notas', p.notas,
      'created_at', p.created_at,
      'updated_at', p.updated_at
    ) as payment
    from app.payments p
    left join app.clients c on c.id = p.provider_id
    , me
    where p.id = $1
      and (me.is_admin or p.fund_id in (select fund_id from allowed_funds))
    limit 1
  `;

  const row = await withUser(userId, (c) => c.query(sql, [id, userId]).then(r => r.rows[0]));
  if (!row) return res.status(404).json({ error: 'No encontrado o sin permiso' });
  res.json(row.payment);
});

/* =============== Crear (admin) =============== */
router.post('/', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  const { rows } = await withUser(userId, (c) =>
    c.query(
      `insert into app.payments
       (fund_id, provider_id, factura_id, num_fc, detalle, fecha_emision, fecha_vencimiento, monto_total, metodo_pago, comprobante_url, estado, notas, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       returning id`,
      [
        p.fund_id,
        p.provider_id,
        p.factura_id ?? null,
        p.num_fc ?? null,
        p.detalle ?? null,
        p.fecha_emision,
        p.fecha_vencimiento ?? null,
        p.monto_total,
        p.metodo_pago ?? null,
        p.comprobante_url ?? null,
        p.estado,             // el trigger puede recalcular por montos si luego se actualiza monto_pagado
        p.notas ?? null,
        userId,
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

  if (p.fund_id !== undefined)            push('fund_id', p.fund_id);
  if (p.provider_id !== undefined)          push('provider_id', p.provider_id ?? null);
  if (p.factura_id !== undefined)         push('factura_id', p.factura_id ?? null);
  if (p.num_fc !== undefined)             push('num_fc', p.num_fc ?? null);
  if (p.detalle !== undefined)            push('detalle', p.detalle ?? null);
  if (p.fecha_emision !== undefined)      push('fecha_emision', p.fecha_emision);
  if (p.fecha_vencimiento !== undefined)  push('fecha_vencimiento', p.fecha_vencimiento ?? null);
  if (p.monto_total !== undefined)        push('monto_total', p.monto_total);
  if (p.metodo_pago !== undefined)        push('metodo_pago', p.metodo_pago ?? null);
  if (p.comprobante_url !== undefined)    push('comprobante_url', p.comprobante_url ?? null);
  if (p.estado !== undefined)             push('estado', p.estado);
  if (p.notas !== undefined)              push('notas', p.notas ?? null);

  if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });

  // updated_by + updated_at
  push('updated_by', userId);
  const setSql = sets.join(', ');

  vals.push(id);
  const row = await withUser(userId, (c) =>
    c.query(
      `update app.payments set ${setSql}, updated_at = now() where id = $${vals.length} returning id`,
      vals
    ).then(r => r.rows[0])
  );
  if (!row) return res.status(404).json({ error: 'No encontrado' });
  res.json({ id: row.id, updated: true });
});

/* =============== Cambiar estado (admin) =============== */
router.patch('/:id/estado', requireRole('admin'), async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const parsed = EstadoBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const row = await withUser(userId, (c) =>
    c.query(
      `update app.payments
          set estado = $1,
              updated_by = $2,
              updated_at = now()
        where id = $3
        returning id, estado`,
      [parsed.data.estado, userId, id]
    ).then(r => r.rows[0])
  );

  if (!row) return res.status(404).json({ error: 'No encontrado' });
  res.json(row);
});

export default router;
