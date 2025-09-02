// src/routes/liquidaciones.ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';
import { requireRole } from '../middleware/requireRole';

const router = Router();

/* ===================== Schemas ===================== */
const PaymentMethod = z.enum(['efectivo', 'transferencia', 'cheques fisicos', 'echeqs', 'otros']);
const LiqStatus = z.enum(['En curso', 'Cerrada', 'Oculta']);

const QList = z.object({
  q: z.string().trim().optional(),
  status: LiqStatus.optional(),
  client_id: z.string().uuid().optional(),
  fund_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const CreateBody = z.object({
  name: z.string().min(1, 'name requerido'),
  client_id: z.string().uuid().optional().nullable(),
  fund_id: z.string().uuid(),
  payment_method: PaymentMethod,
  status: LiqStatus.default('En curso'),
  ingreso_banco: z.coerce.number().default(0),   // 👈 nuevo en create
  impositivo: z.coerce.number().default(0),
  facturas: z.array(z.object({ numero: z.string().trim().min(1), monto: z.coerce.number().positive() })),
  detalle_gastos: z.array(z.object({ detalle: z.string().trim().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  detalle_trabajos: z.array(z.object({ detalle: z.string().trim().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  saldos_positivos: z.array(z.object({ detalle: z.string().trim().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  saldos_negativos: z.array(z.object({ detalle: z.string().trim().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  comentarios: z.array(z.object({ creador: z.string().optional(), mensaje: z.string().trim().min(1) })).default([]),
}).superRefine((v, ctx) => {
  if (!v.facturas?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Debe cargar al menos una factura', path: ['facturas'] });
});

const PatchBody = z.object({
  name: z.string().min(1).optional(),
  client_id: z.string().uuid().nullable().optional(),
  fund_id: z.string().uuid().optional(),
  payment_method: PaymentMethod.optional(),
  status: LiqStatus.optional(),
  ingreso_banco: z.coerce.number().optional(),    // 👈 nuevo en patch
  impositivo: z.coerce.number().optional(),
});

const LinesBody = z.object({
  facturas: z.array(z.object({ numero: z.string().min(1), monto: z.coerce.number().positive() })).default([]),
  detalle_gastos: z.array(z.object({ detalle: z.string().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  detalle_trabajos: z.array(z.object({ detalle: z.string().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  saldos_positivos: z.array(z.object({ detalle: z.string().min(1), monto: z.coerce.number().nonnegative() })).default([]),
  saldos_negativos: z.array(z.object({ detalle: z.string().min(1), monto: z.coerce.number().nonnegative() })).default([]),
});

/* ===================== Rutas ===================== */
/**
 * GET /liquidaciones (listar)
 * - Admin/Owner ven todo
 * - No admin: solo fondos permitidos por role_fund_access
 * - total_final = ingreso_banco - impositivo - gastos - trabajos - saldos_negativos + saldos_positivos
 */
router.get('/', async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });

  const q = QList.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: q.error.flatten() });
  const { q: text, status, client_id, fund_id, limit, offset } = q.data;

  const params: any[] = [userId];
  const where: string[] = [];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$$', `$${params.length}`)); };

  if (status) add('r.status = $$', status);
  if (client_id) add('r.client_id = $$', client_id);
  if (fund_id) add('r.fund_id = $$', fund_id);
  if (text) add('(r.name ilike $$)', `%${text}%`);

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
    ),
    base as (
      -- calificamos columnas para evitar ambigüedades
      select
        r.*,
        l.impositivo     as impositivo_hdr,
        l.ingreso_banco  as ingreso_banco_hdr
      from app.liquidaciones_resumen r
      join app.liquidaciones l on l.id = r.id
      ${where.length ? 'where ' + where.join(' and ') : ''}
    )
    select
      b.*,
      round( (coalesce(b.ingreso_banco_hdr,0)
              - coalesce(b.impositivo_hdr,0)
              - coalesce(b.subtotal_gastos_y_pagos_adm,0)
              - coalesce(b.subtotal_trabajos,0)
              - coalesce(b.saldos_negativos,0)
              + coalesce(b.saldos_positivos,0)
            )::numeric, 2) as total_final
    from base b, me
    where me.is_admin or b.fund_id in (select fund_id from allowed_funds)
    order by b.created_at desc
    limit ${limit} offset ${offset};
  `;

  const rows = await withUser(userId, (c) => c.query(sql, params).then(r => r.rows));
  res.json(rows);
});

/**
 * GET /liquidaciones/:id (detalle)
 * - mismo gating de fondos que el listado
 */
router.get('/:id', async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  const { id } = req.params;

  const sql = `
    with me as (
      select exists(
        select 1
          from app.user_roles ur
          join app.roles rr on rr.id = ur.role_id
        where ur.user_id = $2
          and lower(rr.name) in ('admin','owner')
      ) as is_admin
    ),
    allowed_funds as (
      select distinct rfa.fund_id
        from app.user_roles ur
        join app.role_fund_access rfa on rfa.role_id = ur.role_id
       where ur.user_id = $2
         and rfa.scope in ('read','write','admin')
    ),
    d as (
      select r.*, l.impositivo, l.ingreso_banco
        from app.liquidaciones_resumen r
        join app.liquidaciones l on l.id = r.id
       where r.id = $1
    )
    select json_build_object(
      'id', l.id,
      'name', l.name,
      'client_id', l.client_id,
      'fund_id', l.fund_id,
      'payment_method', l.payment_method,
      'impositivo', l.impositivo,
      'ingreso_banco', l.ingreso_banco,
      'status', l.status,
      'created_at', l.created_at,
      'updated_at', l.updated_at,
      'resumen', json_build_object(
        'total_liquidacion', r.total_liquidacion,
        'neto_liquidacion',  r.neto_liquidacion,
        'iva_liquidacion',   r.iva_liquidacion,
        'subtotal_gastos_y_pagos_adm', r.subtotal_gastos_y_pagos_adm,
        'subtotal_trabajos', r.subtotal_trabajos,
        'saldos_positivos',  r.saldos_positivos,
        'saldos_negativos',  r.saldos_negativos,
        'facturas_count',    r.facturas_count,
        'total_final', round( (coalesce(l.ingreso_banco,0)
                               - coalesce(l.impositivo,0)
                               - coalesce(r.subtotal_gastos_y_pagos_adm,0)
                               - coalesce(r.subtotal_trabajos,0)
                               - coalesce(r.saldos_negativos,0)
                               + coalesce(r.saldos_positivos,0)
                             )::numeric, 2)
      ),
      'facturas',         coalesce(lf.items, '[]'::json),
      'detalle_gastos',   coalesce(lg.items, '[]'::json),
      'detalle_trabajos', coalesce(lt.items, '[]'::json),
      'saldos_positivos', coalesce(lsp.items, '[]'::json),
      'saldos_negativos', coalesce(lsn.items, '[]'::json),
      'comentarios',      coalesce(lc.items, '[]'::json)
    ) as liquidacion
    from app.liquidaciones l
    join d r on r.id = l.id
    cross join me
    left join lateral (
      select json_agg(json_build_object('id', id, 'numero', numero, 'monto', monto)
                      order by created_at asc) as items
      from app.liquidacion_facturas where liquidacion_id = l.id
    ) lf on true
    left join lateral (
      select json_agg(json_build_object('id', id, 'detalle', detalle, 'monto', monto)
                      order by created_at asc) as items
      from app.liquidacion_gastos where liquidacion_id = l.id
    ) lg on true
    left join lateral (
      select json_agg(json_build_object('id', id, 'detalle', detalle, 'monto', monto)
                      order by created_at asc) as items
      from app.liquidacion_trabajos where liquidacion_id = l.id
    ) lt on true
    left join lateral (
      select json_agg(json_build_object('id', id, 'detalle', detalle, 'monto', monto)
                      order by created_at asc) as items
      from app.liquidacion_saldos_positivos where liquidacion_id = l.id
    ) lsp on true
    left join lateral (
      select json_agg(json_build_object('id', id, 'detalle', detalle, 'monto', monto)
                      order by created_at asc) as items
      from app.liquidacion_saldos_negativos where liquidacion_id = l.id
    ) lsn on true
    left join lateral (
      select json_agg(json_build_object('id', id, 'creador', creador, 'mensaje', mensaje, 'created_at', created_at)
                      order by created_at asc) as items
      from app.liquidacion_comentarios where liquidacion_id = l.id
    ) lc on true
    where (me.is_admin or r.fund_id in (select fund_id from allowed_funds))
      and l.id = $1
    limit 1;
  `;

  const row = await withUser(userId, (c) => c.query(sql, [id, userId]).then(r => r.rows[0]));
  if (!row) return res.status(404).json({ error: 'No encontrada o sin permiso' });
  res.json(row.liquidacion);
});

/* ===================== Crear / Editar / Eliminar ===================== */

router.post('/', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;

  const createdId = await withUser(userId, async (c) => {
    await c.query('begin');
    try {
      const { rows: [l] } = await c.query(
        `insert into app.liquidaciones (name, client_id, fund_id, payment_method, impositivo, ingreso_banco, status)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id`,
        [input.name, input.client_id ?? null, input.fund_id, input.payment_method, input.impositivo, input.ingreso_banco, input.status]
      );

      const bulk = async (table: string, cols: string[], items: any[], pick: (x: any) => any[]) => {
        if (!Array.isArray(items) || items.length === 0) return;
        const values: any[] = [];
        const tuples: string[] = [];
        items.forEach((it, i) => {
          const base = i * cols.length;
          tuples.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
          values.push(...pick(it));
        });
        await c.query(`insert into ${table} (${cols.join(',')}) values ${tuples.join(',')}`, values);
      };

      await bulk('app.liquidacion_facturas', ['liquidacion_id','numero','monto'], input.facturas, f => [l.id, String(f.numero), Number(f.monto)]);
      await bulk('app.liquidacion_gastos', ['liquidacion_id','detalle','monto'], input.detalle_gastos, g => [l.id, String(g.detalle), Number(g.monto)]);
      await bulk('app.liquidacion_trabajos', ['liquidacion_id','detalle','monto'], input.detalle_trabajos, t => [l.id, String(t.detalle), Number(t.monto)]);
      await bulk('app.liquidacion_saldos_positivos', ['liquidacion_id','detalle','monto'], input.saldos_positivos, sp => [l.id, String(sp.detalle), Number(sp.monto)]);
      await bulk('app.liquidacion_saldos_negativos', ['liquidacion_id','detalle','monto'], input.saldos_negativos, sn => [l.id, String(sn.detalle), Number(sn.monto)]);
      await bulk('app.liquidacion_comentarios', ['liquidacion_id','creador','mensaje'], input.comentarios, cm => [l.id, String(cm.creador ?? 'sistema'), String(cm.mensaje)]);

      await c.query('commit');
      return l.id;
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  res.status(201).json({ id: createdId });
});

/**
 * PUT /liquidaciones/:id/lines  -> Reemplaza TODAS las líneas (solo admin)
 */
router.put('/:id/lines', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const parsed = LinesBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;

  await withUser(userId, async (c) => {
    await c.query('begin');
    try {
      // borrar existentes
      await c.query('delete from app.liquidacion_facturas where liquidacion_id = $1', [id]);
      await c.query('delete from app.liquidacion_gastos where liquidacion_id = $1', [id]);
      await c.query('delete from app.liquidacion_trabajos where liquidacion_id = $1', [id]);
      await c.query('delete from app.liquidacion_saldos_positivos where liquidacion_id = $1', [id]);
      await c.query('delete from app.liquidacion_saldos_negativos where liquidacion_id = $1', [id]);

      const bulk = async (table: string, cols: string[], items: any[], pick: (x: any) => any[]) => {
        if (!items?.length) return;
        const values: any[] = [];
        const tuples: string[] = [];
        items.forEach((it, i) => {
          const base = i * cols.length;
          tuples.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
          values.push(...pick(it));
        });
        await c.query(`insert into ${table} (${cols.join(',')}) values ${tuples.join(',')}`, values);
      };

      await bulk('app.liquidacion_facturas', ['liquidacion_id','numero','monto'], input.facturas, f => [id, String(f.numero), Number(f.monto)]);
      await bulk('app.liquidacion_gastos', ['liquidacion_id','detalle','monto'], input.detalle_gastos, g => [id, String(g.detalle), Number(g.monto)]);
      await bulk('app.liquidacion_trabajos', ['liquidacion_id','detalle','monto'], input.detalle_trabajos, t => [id, String(t.detalle), Number(t.monto)]);
      await bulk('app.liquidacion_saldos_positivos', ['liquidacion_id','detalle','monto'], input.saldos_positivos, sp => [id, String(sp.detalle), Number(sp.monto)]);
      await bulk('app.liquidacion_saldos_negativos', ['liquidacion_id','detalle','monto'], input.saldos_negativos, sn => [id, String(sn.detalle), Number(sn.monto)]);

      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  res.json({ id, linesReplaced: true });
});

router.patch('/:id', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;

  const sets: string[] = [];
  const params: any[] = [];
  const addSet = (k: string, v: any) => { params.push(v); sets.push(`${k} = $${params.length}`); };

  if (typeof input.name !== 'undefined') addSet('name', input.name);
  if (typeof input.client_id !== 'undefined') addSet('client_id', input.client_id);
  if (typeof input.fund_id !== 'undefined') addSet('fund_id', input.fund_id);
  if (typeof input.payment_method !== 'undefined') addSet('payment_method', input.payment_method);
  if (typeof input.ingreso_banco !== 'undefined') addSet('ingreso_banco', input.ingreso_banco);
  if (typeof input.impositivo !== 'undefined') addSet('impositivo', input.impositivo);
  if (typeof input.status !== 'undefined') addSet('status', input.status);

  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

  params.push(id);
  const sql = `update app.liquidaciones set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning id`;
  const row = await withUser(userId, (c) => c.query(sql, params).then(r => r.rows[0]));
  if (!row) return res.status(404).json({ error: 'No encontrada' });

  res.json({ id: row.id, updated: true });
});

router.delete('/:id', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const row = await withUser(userId, (c) =>
    c.query('delete from app.liquidaciones where id = $1 returning id', [id]).then(r => r.rows[0])
  );
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json({ id: row.id, deleted: true });
});

export default router;
