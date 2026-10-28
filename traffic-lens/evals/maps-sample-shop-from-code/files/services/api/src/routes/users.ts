import { Router } from 'express';
import { prisma } from '../lib/db';
import { requireAuth } from '../lib/auth';

const r = Router();

r.get('/:id', requireAuth, async (req, res) => {
  res.json(await prisma.user.findUnique({ where: { id: Number(req.params.id) } }));
});

export default r;
