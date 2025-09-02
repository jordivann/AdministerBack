// src/util/http.ts
import { Response } from 'express';

export function ok(res: Response, data: any, status = 200) {
  return res.status(status).json(data);
}

export function fail(res: Response, err: any, status = 400) {
  const msg = err?.message || String(err);
  return res.status(status).json({ error: msg });
}
