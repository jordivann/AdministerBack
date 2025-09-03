// src/routes/transactions.ts
import { Router } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';
import { withUser } from '../db';
import { assertWriteForFunds } from '../permissions';
import { requireRole } from '../middleware/requireRole';

const router = Router();

/* ===================== Schemas ===================== */
// ⚠️ from/to como string YYYY-MM-DD para evitar desfase por timezone
const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fund_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const TxInput = z.object({
  account_id: z.string().uuid(),
  tx_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
  description: z.string().trim().nullable().optional(),
  amount: z.number().positive(),
  type: z.enum(['credit', 'debit']),
  fund_id: z.string().uuid().optional(), // atajo para un único fondo
  category_id: z.string().uuid().nullable().optional(),
  allocations: z
    .array(
      z.object({
        fund_id: z.string().uuid(),
        ratio: z.number().positive(),
      })
    )
    .optional(),
});

/* ===================== Helpers ===================== */
async function isAdmin(client: any, userId: string): Promise<boolean> {
  const q = await client.query(
    `select exists (
       select 1
       from app.user_roles ur
       join app.roles r on r.id = ur.role_id
       where ur.user_id = $1 and lower(r.name) in ('admin','owner')
     ) as ok`,
    [userId]
  );
  return Boolean(q.rows?.[0]?.ok);
}

/* ===================== Endpoints ===================== */

/** GET /transactions/accounts  ->  { id, name, currency }[] */
router.get('/accounts', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const rows = await withUser(userId, async (c) => {
    const q = await c.query(`
      select a.id, a.name, a.currency
      from app.accounts a
      order by a.name
    `);
    return q.rows;
  });
  res.json(rows);
});

/** GET /transactions?from=&to=&fund_id=&account_id=&category_id=&q=&limit=&offset= */
router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const { from, to, fund_id, account_id, category_id, q, limit, offset } =
    Range.parse(req.query);

  const rows = await withUser(userId, async (c) => {
    const sql = `
      with is_admin as (
        select exists (
          select 1
          from app.user_roles ur
          join app.roles r on r.id = ur.role_id
          where ur.user_id = $1
            and lower(r.name) in ('admin','owner')
        ) as ok
      )
      select
        v.transaction_id                         as id,
        to_char(v.tx_date::date, 'YYYY-MM-DD') as tx_date,
        v.account_id,
        a.name                                   as account_name,
        v.fund_id,
        f.name                                   as fund_name,
        v.currency,
        v.description,
        v.type,
        v.ratio,
        v.amount::float8                         as amount,
        v.amount_signed::float8                  as amount_signed,
        v.amount_signed_alloc::float8            as amount_signed_alloc,
        coalesce( v.amount_signed_alloc::float8,
                  v.amount_signed::float8,
                  case when v.type = 'debit' then -abs(v.amount::float8)
                       else abs(v.amount::float8) end
        )                                        as amount_effective,
        t.category_id,
        c.name                                   as category_name
      from app.v_tx_allocated v
      left join app.bank_transactions t on t.id = v.transaction_id
      left join app.categories        c on c.id = t.category_id
      left join app.accounts a on a.id = v.account_id
      left join app.funds   f on f.id = v.fund_id
      left join app.v_effective_fund_access efa
             on efa.fund_id = v.fund_id and efa.user_id = $1
      cross join is_admin ia
      where (ia.ok = true or efa.user_id is not null)
        and ($2::date  is null or v.tx_date >= $2::date)
        and ($3::date  is null or v.tx_date <  ($3::date + 1))
        and ($4::uuid  is null or v.fund_id    =  $4::uuid)
        and ($5::uuid  is null or v.account_id =  $5::uuid)
        and ($6::uuid  is null or t.category_id=  $6::uuid)
        and ($7::text  is null or v.description ilike '%'||$7::text||'%')
      order by v.tx_date desc, v.transaction_id
      limit  coalesce($8::int, 1000)
      offset coalesce($9::int, 0)
    `;
    const qres = await c.query(sql, [
      userId, // $1
      from ?? null, // $2
      to ?? null, // $3
      fund_id ?? null, // $4
      account_id ?? null, // $5
      category_id ?? null, // $6
      q ?? null, // $7
      limit ?? null, // $8
      offset ?? null, // $9
    ]);
    return qres.rows;
  });

  res.json(rows);
});

/** POST /transactions
 *  Reglas:
 *  - Debe venir un fondo: o allocations (sum=1) o fund_id (se convierte a allocations=[{ratio:1}])
 *  - NO se permite "sin fondo"
 */
router.post('/', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;

  const parsed = TxInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    const e: any = new Error(parsed.error.issues?.[0]?.message ?? 'invalid body');
    e.status = 400;
    throw e;
  }
  const input = parsed.data;

  // construir allocations
  let allocations: { fund_id: string; ratio: number }[] = Array.isArray(
    input.allocations
  )
    ? input.allocations
    : [];
  if (allocations.length === 0 && input.fund_id) {
    allocations = [{ fund_id: input.fund_id, ratio: 1 }];
  }
  if (allocations.length === 0) {
    const e: any = new Error('a fund is required (use fund_id or allocations)');
    e.status = 400;
    throw e;
  }
  const sum = allocations.reduce((acc, a) => acc + Number(a.ratio), 0);
  if (Math.abs(sum - 1) > 1e-9) {
    const e: any = new Error('allocations ratio sum must be 1');
    e.status = 400;
    throw e;
  }
  const fundIds = [...new Set(allocations.map((a) => a.fund_id))];

  const id = await withUser(userId, async (c) => {
    await assertWriteForFunds(c, userId, fundIds);

    // guardamos category_id también
    const txQ = await c.query<{ id: string }>(
      `insert into app.bank_transactions (account_id, tx_date, description, amount, type, category_id)
       values ($1, $2::date, $3, $4::numeric, $5::app.tx_type, $6::uuid)
       returning id`,
      [
        input.account_id,
        input.tx_date,
        input.description ?? null,
        input.amount,
        input.type,
        input.category_id ?? null,
      ]
    );
    const txId = txQ.rows[0].id;

    for (const a of allocations) {
      await c.query(
        `insert into app.transaction_allocations (transaction_id, fund_id, ratio)
         values ($1, $2, $3)`,
        [txId, a.fund_id, a.ratio]
      );
    }
    return txId;
  });

  res.status(201).json({ id });
});

/** PATCH /transactions/:id */
router.patch('/:id', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const txId = z.string().uuid().parse(req.params.id);

  const Body = TxInput.partial();
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    const e: any = new Error(parsed.error.issues?.[0]?.message ?? 'invalid body');
    e.status = 400;
    throw e;
  }
  const body = parsed.data;

  await withUser(userId, async (c) => {
    // preparar allocations si vinieron
    let newAlloc: { fund_id: string; ratio: number }[] | undefined = undefined;

    if (body.fund_id) {
      newAlloc = [{ fund_id: body.fund_id, ratio: 1 }];
    } else if (Array.isArray(body.allocations)) {
      if (body.allocations.length === 0) {
        const e: any = new Error('allocations cannot be empty');
        e.status = 400;
        throw e;
      }
      const sum = body.allocations.reduce((acc, a) => acc + Number(a.ratio), 0);
      if (Math.abs(sum - 1) > 1e-9) {
        const e: any = new Error('allocations ratio sum must be 1');
        e.status = 400;
        throw e;
      }
      newAlloc = body.allocations;
    }

    if (newAlloc) {
      const fundIds = [...new Set(newAlloc.map((a) => a.fund_id))];
      await assertWriteForFunds(c, userId, fundIds);
    }

    // update base (incluye category_id)
    await c.query(
      `update app.bank_transactions
         set account_id = coalesce($2, account_id),
             tx_date    = coalesce($3::date, tx_date),
             description= coalesce($4, description),
             amount     = coalesce($5::numeric, amount),
             type       = coalesce($6::app.tx_type, type),
             category_id= coalesce($7::uuid, category_id)
       where id = $1`,
      [
        txId,
        body.account_id ?? null,
        body.tx_date ?? null,
        body.description ?? null,
        body.amount ?? null,
        body.type ?? null,
        body.category_id ?? null,
      ]
    );

    // re-asignar si corresponde
    if (newAlloc) {
      await c.query(
        `delete from app.transaction_allocations where transaction_id = $1`,
        [txId]
      );
      for (const a of newAlloc) {
        await c.query(
          `insert into app.transaction_allocations (transaction_id, fund_id, ratio)
           values ($1, $2, $3)`,
          [txId, a.fund_id, a.ratio]
        );
      }
    }
  });

  res.json({ ok: true, id: txId });
});

router.delete('/:id', requireRole('admin'), async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const txId = z.string().uuid().parse(req.params.id);

  await withUser(userId, async (c) => {
    await c.query('begin');
    try {
      // Si tu constraint trigger se llama, por ejemplo, ta_sum_check (deferrable):
      // await c.query(`set constraints ta_sum_check deferred`);

      const { rowCount } = await c.query(
        'delete from app.bank_transactions where id = $1 returning id',
        [txId]
      );
      if (rowCount === 0) {
        const e: any = new Error('Transacción no encontrada');
        e.status = 404;
        throw e;
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  // 204 = No Content
  res.status(204).send();
});
export default router;
