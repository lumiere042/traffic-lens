import { Router } from 'express';
import { prisma } from '../lib/db';
import { redis } from '../lib/redis';

const r = Router();

r.get('/', async (_req, res) => {
  const cached = await redis.get('products:all');
  if (cached) return res.json(JSON.parse(cached));
  const products = await prisma.product.findMany();
  await redis.set('products:all', JSON.stringify(products), 'EX', 60);
  res.json(products);
});

r.get('/:id', async (req, res) => {
  res.json(await prisma.product.findUnique({ where: { id: Number(req.params.id) } }));
});

export default r;
