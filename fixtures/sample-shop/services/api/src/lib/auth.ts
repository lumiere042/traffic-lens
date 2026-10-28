import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).end();
  try { (req as any).user = jwt.verify(token, process.env.JWT_SECRET!); next(); }
  catch { res.status(401).end(); }
}
