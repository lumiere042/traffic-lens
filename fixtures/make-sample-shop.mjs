// Writes fixtures/sample-shop/ (a small multi-service repo) and fixtures/sample-session.har.
// Planted issues: web calls GET /users/:id/profile (api only has /users/:id); notifier calls
// POST /internal/orders/:id/notified (doesn't exist); /admin routes have no auth; the browser
// talks to Mixpanel directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample-shop');
const files = {
  'README.md': `# sample-shop

Tiny shop: Next.js storefront, Express API, FastAPI payments service, Python notifier worker.
Run everything with \`docker compose up\`.
`,
  'docker-compose.yml': `services:
  web:
    build: ./apps/web
    ports: ["3000:3000"]
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:4000
  api:
    build: ./services/api
    ports: ["4000:4000"]
    environment:
      DATABASE_URL: postgres://shop:shop@postgres:5432/shop
      REDIS_URL: redis://redis:6379
      AMQP_URL: amqp://rabbitmq:5672
      PAYMENTS_URL: http://payments:8000
      PAYMENTS_TOKEN: dev-internal-token
    depends_on: [postgres, redis, rabbitmq, payments]
  payments:
    build: ./services/payments
    environment:
      STRIPE_API_KEY: sk_test_123
      INTERNAL_TOKEN: dev-internal-token
  notifier:
    build: ./services/notifier
    environment:
      AMQP_URL: amqp://rabbitmq:5672
      API_URL: http://api:4000
      SENDGRID_API_KEY: SG.test
    depends_on: [rabbitmq]
  postgres:
    image: postgres:16
  redis:
    image: redis:7
  rabbitmq:
    image: rabbitmq:3-management
`,
  'apps/web/package.json': `{ "name": "web", "private": true, "dependencies": { "next": "14.2.5", "react": "18.3.1", "axios": "1.7.2" } }
`,
  'apps/web/lib/api.ts': `import axios from 'axios';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
});

export function authHeaders(token: string) {
  return { headers: { Authorization: \`Bearer \${token}\` } };
}
`,
  'apps/web/lib/analytics.ts': `export async function track(event: string, props: Record<string, unknown>) {
  await fetch('https://api.mixpanel.com/track', {
    method: 'POST',
    body: JSON.stringify([{ event, properties: props }]),
  });
}
`,
  'apps/web/app/products/page.tsx': `import { api } from '../../lib/api';
import { track } from '../../lib/analytics';

export default async function ProductsPage() {
  const { data: products } = await api.get('/products');
  track('products_viewed', { count: products.length });
  return <ul>{products.map((p: any) => <li key={p.id}><a href={\`/products/\${p.id}\`}>{p.name}</a></li>)}</ul>;
}

export async function getProduct(id: string) {
  const { data } = await api.get(\`/products/\${id}\`);
  return data;
}
`,
  'apps/web/app/cart/actions.ts': `'use server';
import { api, authHeaders } from '../../lib/api';

export async function addToCart(token: string, productId: string, qty: number) {
  return api.post('/cart', { productId, qty }, authHeaders(token));
}

export async function removeFromCart(token: string, itemId: string) {
  return api.delete(\`/cart/\${itemId}\`, authHeaders(token));
}

export async function checkout(token: string) {
  const { data } = await api.post('/cart/checkout', {}, authHeaders(token));
  return data.orderId;
}
`,
  'apps/web/app/account/page.tsx': `import { api, authHeaders } from '../../lib/api';

export default async function AccountPage({ token, userId }: { token: string; userId: string }) {
  const { data: profile } = await api.get(\`/users/\${userId}/profile\`, authHeaders(token));
  return <h1>{profile.name}</h1>;
}
`,
  'services/api/package.json': `{ "name": "api", "private": true, "dependencies": { "express": "4.19.2", "ioredis": "5.4.1", "@prisma/client": "5.16.1", "amqplib": "0.10.4", "axios": "1.7.2", "jsonwebtoken": "9.0.2" } }
`,
  'services/api/prisma/schema.prisma': `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
model Product { id Int @id name String priceCents Int }
model CartItem { id Int @id userId Int productId Int qty Int }
model Order { id Int @id userId Int totalCents Int status String }
model User { id Int @id email String name String }
`,
  'services/api/src/server.ts': `import express from 'express';
import { requireAuth } from './lib/auth';
import products from './routes/products';
import cart from './routes/cart';
import users from './routes/users';
import admin from './routes/admin';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));
app.use('/products', products);
app.use('/cart', requireAuth, cart);
app.use('/users', users);
app.use('/admin', admin);

app.listen(4000);
`,
  'services/api/src/lib/auth.ts': `import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).end();
  try { (req as any).user = jwt.verify(token, process.env.JWT_SECRET!); next(); }
  catch { res.status(401).end(); }
}
`,
  'services/api/src/lib/redis.ts': `import Redis from 'ioredis';
export const redis = new Redis(process.env.REDIS_URL!);
`,
  'services/api/src/lib/db.ts': `import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
`,
  'services/api/src/lib/events.ts': `import amqp from 'amqplib';

let channel: amqp.Channel;
export async function publishOrderPlaced(order: { id: number; userId: number }) {
  if (!channel) {
    const conn = await amqp.connect(process.env.AMQP_URL!);
    channel = await conn.createChannel();
    await channel.assertQueue('order.placed');
  }
  channel.sendToQueue('order.placed', Buffer.from(JSON.stringify(order)));
}
`,
  'services/api/src/routes/products.ts': `import { Router } from 'express';
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
`,
  'services/api/src/routes/cart.ts': `import { Router } from 'express';
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
`,
  'services/api/src/routes/users.ts': `import { Router } from 'express';
import { prisma } from '../lib/db';
import { requireAuth } from '../lib/auth';

const r = Router();

r.get('/:id', requireAuth, async (req, res) => {
  res.json(await prisma.user.findUnique({ where: { id: Number(req.params.id) } }));
});

export default r;
`,
  'services/api/src/routes/admin.ts': `import { Router } from 'express';
import { prisma } from '../lib/db';

// TODO: lock this down before launch
const r = Router();

r.delete('/users/:id', async (req, res) => {
  await prisma.user.delete({ where: { id: Number(req.params.id) } });
  res.status(204).end();
});

r.get('/orders', async (_req, res) => res.json(await prisma.order.findMany()));

export default r;
`,
  'services/payments/requirements.txt': `fastapi==0.111.0
uvicorn==0.30.1
stripe==9.12.0
`,
  'services/payments/main.py': `import os
import stripe
from fastapi import FastAPI, Depends, Header, HTTPException

stripe.api_key = os.environ["STRIPE_API_KEY"]
app = FastAPI()


def verify_internal_token(x_internal_token: str = Header(...)):
    if x_internal_token != os.environ["INTERNAL_TOKEN"]:
        raise HTTPException(status_code=403)


@app.post("/charges", dependencies=[Depends(verify_internal_token)])
def create_charge(body: dict):
    intent = stripe.PaymentIntent.create(amount=body["amount"], currency="usd", metadata={"user": body["userId"]})
    return {"id": intent.id, "status": intent.status}


@app.get("/charges/{charge_id}", dependencies=[Depends(verify_internal_token)])
def get_charge(charge_id: str):
    intent = stripe.PaymentIntent.retrieve(charge_id)
    return {"id": intent.id, "status": intent.status}
`,
  'services/notifier/requirements.txt': `pika==1.3.2
sendgrid==6.11.0
requests==2.32.3
`,
  'services/notifier/worker.py': `import json
import os

import pika
import requests
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

API_URL = os.environ["API_URL"]
sg = SendGridAPIClient(os.environ["SENDGRID_API_KEY"])


def on_order_placed(ch, method, properties, body):
    order = json.loads(body)
    sg.send(Mail(from_email="shop@example.com", to_emails="customer@example.com",
                 subject=f"Order {order['id']} confirmed", html_content="Thanks!"))
    requests.post(f"{API_URL}/internal/orders/{order['id']}/notified", timeout=5)
    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    conn = pika.BlockingConnection(pika.URLParameters(os.environ["AMQP_URL"]))
    channel = conn.channel()
    channel.queue_declare(queue="order.placed")
    channel.basic_consume(queue="order.placed", on_message_callback=on_order_placed)
    channel.start_consuming()


if __name__ == "__main__":
    main()
`,
};

fs.rmSync(root, { recursive: true, force: true });
for (const [rel, content] of Object.entries(files)) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// HAR: a browser session against the local stack
const t0 = Date.parse('2026-10-24T15:00:00Z');
const entries = [];
const add = (method, url, status, time, auth = false, type = 'fetch') => entries.push({
  startedDateTime: new Date(t0 + entries.length * 700).toISOString(), time, _resourceType: type,
  request: { method, url, headers: auth ? [{ name: 'Authorization', value: 'Bearer eyJ.redacted' }] : [], cookies: [] },
  response: { status, content: { mimeType: 'application/json' } },
});
for (let i = 0; i < 24; i++) add('GET', 'http://localhost:4000/products', 200, 18 + (i % 7) * 4);
for (let i = 0; i < 30; i++) add('GET', `http://localhost:4000/products/${100 + i * 3}`, i % 15 === 4 ? 500 : 200, 22 + (i % 5) * 6);
for (let i = 0; i < 12; i++) add('POST', 'http://localhost:4000/cart', 201, 35, true);
for (let i = 0; i < 4; i++) add('DELETE', `http://localhost:4000/cart/${900 + i}`, 204, 20, true);
for (let i = 0; i < 5; i++) add('POST', 'http://localhost:4000/cart/checkout', i === 3 ? 502 : 200, 900 + i * 250, true);
for (let i = 0; i < 6; i++) add('GET', 'http://localhost:4000/users/42/profile', 404, 9, true);
add('GET', 'http://localhost:4000/admin/orders', 200, 40, false);
for (let i = 0; i < 20; i++) add('POST', 'https://api.mixpanel.com/track', 200, 60, false, 'xhr');
for (const f of ['main.js', 'framework.js', 'app.css']) add('GET', 'http://localhost:3000/_next/static/' + f, 200, 5, false, f.endsWith('js') ? 'script' : 'stylesheet');
fs.writeFileSync(path.join(path.dirname(root), 'sample-session.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'Chrome' }, pages: [], entries } }, null, 1));
console.log(`wrote ${Object.keys(files).length} repo files and ${entries.length} HAR entries`);
