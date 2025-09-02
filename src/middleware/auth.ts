// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthedRequest extends Request {
  user?: { id: string };
}

export function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : undefined;
  if (!token) return res.status(401).json({ error: 'missing token' });

  // Opcional: modo laxo en dev para no trabarte si falta ISS/AUD (NO usar en prod)
  const strict = process.env.AUTH_STRICT !== '0';

  const verifyOpts: jwt.VerifyOptions = { algorithms: ['HS256'] };
  if (strict) {
    // solo exigimos iss/aud si están configurados (evita mismatch de env)
    if (process.env.JWT_ISS) verifyOpts.issuer = process.env.JWT_ISS;
    if (process.env.JWT_AUD) verifyOpts.audience = process.env.JWT_AUD;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!, verifyOpts) as any;

    if (!payload?.sub) return res.status(401).json({ error: 'invalid token: sub missing' });
    req.user = { id: String(payload.sub) };
    next();
  } catch (e: any) {
    // 👇 deja rastros útiles en consola
    console.error('[AUTH] JWT verify failed:', {
      message: e?.message,
      name: e?.name,
      code: e?.code,
      expected_iss: process.env.JWT_ISS,
      expected_aud: process.env.JWT_AUD,
      strict,
    });
    return res.status(401).json({ error: 'invalid token', code: 'JWT_VERIFY_FAILED' });
  }
}
