// In-memory message bus: publishers POST to a topic, consumers long-poll for the next
// message. Stands in for RabbitMQ/SQS so the demo needs no infrastructure.
import { createApp } from '../../shared/router.mjs';

const PORT = Number(process.env.PORT || 4003);
const WAIT_MS = 20_000;

const topics = new Map(); // topic -> { messages: [], waiters: [] }
const topic = (name) => {
  if (!topics.has(name)) topics.set(name, { messages: [], waiters: [] });
  return topics.get(name);
};

const app = createApp();

app.post('/topics/:topic', (req, res) => {
  const t = topic(req.params.topic);
  const waiter = t.waiters.shift();
  if (waiter) waiter(req.body);
  else t.messages.push(req.body);
  res.json(202, { queued: t.messages.length });
});

app.get('/topics/:topic/next', async (req, res) => {
  const t = topic(req.params.topic);
  if (t.messages.length) return res.json(200, t.messages.shift());
  const message = await new Promise((resolve) => {
    const waiter = (m) => { clearTimeout(timer); resolve(m); };
    const timer = setTimeout(() => {
      t.waiters.splice(t.waiters.indexOf(waiter), 1);
      resolve(null);
    }, WAIT_MS);
    t.waiters.push(waiter);
  });
  if (message) res.json(200, message);
  else res.json(204);
});

app.get('/topics', (req, res) => {
  res.json(200, Object.fromEntries([...topics].map(([k, v]) => [k, { pending: v.messages.length, consumers: v.waiters.length }])));
});

app.listen(PORT, () => console.log(`event-bus listening on :${PORT}`));
