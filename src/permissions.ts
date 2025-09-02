// src/permissions.ts
import type { PoolClient } from 'pg';

export async function getVisibleFundIds(client: PoolClient, userId: string): Promise<string[]> {
  const q = await client.query<{ fund_id: string }>(
    `select distinct fund_id
       from app.v_effective_fund_access
      where user_id = $1`,
    [userId]
  );
  return q.rows.map(r => r.fund_id);
}

export async function assertWriteForFunds(client: PoolClient, userId: string, fundIds: string[]) {
  if (fundIds.length === 0) return;

  const q = await client.query<{ cnt: string }>(
    `select count(distinct fund_id)::int as cnt
       from app.v_effective_fund_access
      where user_id = $1
        and fund_id = any($2::uuid[])
        and scope in ('write','admin')`,
    [userId, fundIds]
  );

  const ok = Number(q.rows[0]?.cnt ?? 0) === fundIds.length;
  if (!ok) {
    const e: any = new Error('forbidden: missing write/admin on one or more funds');
    e.status = 403;
    throw e;
  }
}
