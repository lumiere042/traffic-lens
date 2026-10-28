// Consumes post.events: writes a JSON snapshot of each post to the export folder,
// notifies the configured webhook, and marks the post as indexed in posts-api.
import fs from 'node:fs';
import path from 'node:path';
import { createTelemetry } from '../../shared/telemetry.mjs';

const BUS_URL = process.env.BUS_URL || 'http://localhost:4003';
const POSTS_URL = process.env.POSTS_URL || 'http://localhost:4002';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://postman-echo.com/post';
const EXPORT_DIR = path.resolve(process.env.EXPORT_DIR || 'data/exports');

const telemetry = createTelemetry('indexer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(EXPORT_DIR, { recursive: true });

async function handle(message) {
  const { type, post } = message;
  const file = path.join(EXPORT_DIR, `post-${post.id}.json`);
  if (type === 'post.deleted') fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(post, null, 2));

  await telemetry.fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: type, postId: post.id, at: new Date().toISOString() }),
  });

  if (type !== 'post.deleted') {
    const ack = await telemetry.fetch(`${POSTS_URL}/posts/${post.id}/indexed`, { method: 'POST' });
    if (!ack.ok) console.warn(`could not mark post ${post.id} as indexed (${ack.status})`);
  }
  console.log(`indexed ${type} #${post.id}`);
}

async function run() {
  console.log(`indexer consuming post.events from ${BUS_URL}`);
  for (;;) {
    try {
      const res = await fetch(`${BUS_URL}/topics/post.events/next`);
      if (res.status === 204) continue;
      const message = await res.json();
      await telemetry.consumer('post.events', message.traceparent, () => handle(message));
    } catch (err) {
      console.warn(`indexer: ${err.message}; retrying`);
      await sleep(1000);
    }
  }
}

run();
