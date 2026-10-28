import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../lib/db';
import { publishOrderPlaced } from '../lib/events';

const r = Router();
const payments = axios.create({
  baseURL: process.env.PAYMENTS_URL,
  headers: { 'x-internal-token': process.env.PAYMENTS_TOKEN },
});

r.get('/', async (req: any, res) => res.json(await prisma.cartItem.findMany({ where: { userId: req.user.id } })));

r.post('/', async (req: any, res) => {
  res.status(201).json(await prisma.cartItem.create({ data: { userId: req.user.id, ...req.body } }));
});

r.delete('/:itemId', async (req, res) => {
  await prisma.cartItem.delete({ where: { id: Number(req.params.itemId) } });
  res.status(204).end();
});

r.post('/checkout', async (req: any, res) => {
  const items = await prisma.cartItem.findMany({ where: { userId: req.user.id } });
  const totalCents = items.reduce((s, i) => s + i.qty * 1000, 0);
  const { data: charge } = await payments.post('/charges', { userId: req.user.id, amount: totalCents });
  const order = await prisma.order.create({ data: { userId: req.user.id, totalCents, status: charge.status } });
  await publishOrderPlaced(order);
  res.json({ orderId: order.id });
});

export default r;
