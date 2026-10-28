import { Router } from 'express';
import { prisma } from '../lib/db';

// TODO: lock this down before launch
const r = Router();

r.delete('/users/:id', async (req, res) => {
  await prisma.user.delete({ where: { id: Number(req.params.id) } });
  res.status(204).end();
});

r.get('/orders', async (_req, res) => res.json(await prisma.order.findMany()));

export default r;
