// src/routes/transactions_import.ts
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import { z } from 'zod';
import { withUser } from '../db';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// parser permisivo para montos: "40.000,00" / "40,000.00" / "120"
function parseAmountLoose(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/[^\d.,-]/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) { s = s.replace(/\./g, ''); s = s.replace(',', '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (hasComma) { s = s.replace(/\./g, ''); s = s.replace(',', '.'); }
  else { s = s.replace(/,/g, ''); }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const Row = z.object({
  account_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().nullable().optional(),
  amount: z.number().positive(),                 // lo normalizamos antes
  type: z.enum(['credit', 'debit']),
  category_id: z.string().uuid().nullable().optional(),
  fund_id: z.string().uuid(),
});
type Row = z.infer<typeof Row>;

function hasFile(req: Request): req is Request & { file: Express.Multer.File } {
  return !!(req as any).file;
}

router.post(
  '/transactions/import',
  upload.single('file'),
  async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const dryRun = String(req.query.dry_run ?? '0') === '1';

      if (!hasFile(req)) return res.status(400).json({ error: 'Falta archivo CSV (campo "file")' });

      // 1) parse CSV
      const rawRows: any[] = [];
      await new Promise<void>((resolve, reject) => {
        parse(req.file!.buffer, { columns: true, trim: true, skip_empty_lines: true })
          .on('data', (r) => rawRows.push(r))
          .on('end', resolve)
          .on('error', reject);
      });

      // 2) normalizar + validar
      const rows: Row[] = [];
      const errors: Array<{ index: number; error: string; row: any }> = [];

      rawRows.forEach((raw, i) => {
        const amount = parseAmountLoose(raw.amount);
        const parsed = Row.safeParse({
          account_id: raw.account_id,
          date: raw.date ?? raw.tx_date,
          description: raw.description ?? null,
          amount: amount ?? undefined,
          type: String(raw.type ?? '').toLowerCase(),
          category_id: raw.category_id || null,
          fund_id: raw.fund_id,
        });
        if (parsed.success) rows.push(parsed.data);
        else {
          const msg =
            parsed.error.flatten().formErrors.join('; ')
            || parsed.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; ')
            || 'Fila inválida';
          errors.push({ index: i + 2, error: msg, row: raw });
        }
      });

      if (errors.length) {
        return res.status(422).json({ error: 'CSV contiene filas inválidas', errors, valid: rows.length });
      }

      if (dryRun) {
        // si querés validar permisos de fondos, hacelo acá con withUser(userId, ...)
        return res.json({ ok: true, valid: rows.length });
      }

      // 3) inserción real: bank_transactions (sin fund_id) + allocation 1.0 en app.transaction_allocations
      await withUser(userId, async (client) => {
        await client.query('begin');
        try {
          const insertTxSQL = `
            insert into app.bank_transactions
              (account_id, tx_date, description, amount, type, category_id)
            values ($1, $2::date, $3, $4::numeric, $5::app.tx_type, $6::uuid)
            returning id
          `;
          const insertAllocSQL = `
            insert into app.transaction_allocations (transaction_id, fund_id, ratio)
            values ($1::uuid, $2::uuid, 1.0)
          `;

          for (const r of rows) {
            // tu modelo guarda amount POSITIVO, el signo lo aporta "type"
            const unsigned = Math.abs(r.amount);
            const tx = await client.query<{ id: string }>(insertTxSQL, [
              r.account_id,
              r.date,
              r.description ?? null,
              unsigned,
              r.type,
              r.category_id ?? null,
            ]);
            await client.query(insertAllocSQL, [tx.rows[0].id, r.fund_id]);
          }

          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      });

      return res.json({ ok: true, inserted: rows.length });
    } catch (e: any) {
      console.error('transactions/import error:', e);
      return res.status(500).json({ error: e?.message ?? 'Error importando CSV' });
    }
  }
);

export default router;
