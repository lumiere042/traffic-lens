#!/usr/bin/env node
// Drives a real headless Chrome through the Postboard UI and saves the network log as a
// HAR, the same file you'd get from DevTools → Network → "Save all as HAR".
//   node scripts/capture-har.mjs [out=captures/session.har]
// Requires the stack to be running (npm start) and Chrome/Edge installed (or CHROME_PATH).
// Credential values are redacted; header names are kept so auth can still be analysed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const OUT = path.resolve(process.argv[2] || 'captures/session.har');
const PORT = 9333;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the user journey, run inside the page ----------
const TOUR = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const until = async (fn, ms = 15000) => {
    const start = Date.now();
    while (!fn()) { if (Date.now() - start > ms) throw new Error('timed out: ' + fn); await sleep(100); }
  };
  const click = (sel) => $(sel).click();
  const postBtn = (i, action) => document.querySelectorAll('.post')[i].querySelector(`[data-action="${action}"]`);
  const steps = [];
  const step = async (name, fn) => { await fn(); steps.push(name); await sleep(700); };

  await until(() => document.querySelectorAll('.post').length > 0 && $('#login-user option[value]'));
  await step('sign in', async () => {
    $('#login-user').value = 'Bret';
    $('#login-pass').value = 'demo';
    $('#login-form').requestSubmit();
    await until(() => document.body.classList.contains('signed-in'));
  });
  await step('open a post', async () => {
    postBtn(0, 'open').click();
    await until(() => $('#detail').open && $('#comments').textContent !== 'Loading…');
    $('#detail').close();
  });
  await step('search', async () => {
    $('#search').value = 'dolor';
    $('#search-form').requestSubmit();
    await sleep(2500);
    $('#search').value = '';
    $('#search-form').requestSubmit();
    await sleep(800);
  });
  await step('pin a post', async () => { postBtn(1, 'pin').click(); await sleep(900); });
  await step('create a post', async () => {
    click('#new-post');
    $('#post-title').value = 'Hello from the HAR tour';
    $('#post-body').value = 'Captured by scripts/capture-har.mjs';
    $('#composer').requestSubmit();
    await until(() => [...document.querySelectorAll('.post h3')].some((h) => h.textContent.includes('HAR tour')));
  });
  await step('edit the new post', async () => {
    const i = [...document.querySelectorAll('.post h3')].findIndex((h) => h.textContent.includes('HAR tour'));
    postBtn(i, 'edit').click();
    $('#post-title').value = 'Hello from the HAR tour (edited)';
    $('#composer').requestSubmit();
    await sleep(1500);
  });
  await step('edit an upstream post', async () => {
    const i = [...document.querySelectorAll('.post')].findIndex((li) => Number(li.dataset.id) < 1000);
    postBtn(i, 'edit').click();
    $('#post-body').value = 'Edited during the HAR tour';
    $('#composer').requestSubmit();
    await sleep(1500);
  });
  await step('delete a post', async () => {
    const i = [...document.querySelectorAll('.post')].findIndex((li) => Number(li.dataset.id) < 1000);
    postBtn(i, 'delete').click();
    await sleep(1500);
  });
  await step('reset demo data', async () => { click('#reset'); await sleep(1200); });
  return steps;
};

// ---------- CDP plumbing ----------
async function main() {
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'postboard-har-'));
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const requests = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    const p = msg.params;
    if (msg.method === 'Network.requestWillBeSent') {
      requests.set(p.requestId, { request: p.request, type: p.type, start: p.timestamp, wallTime: p.wallTime });
    } else if (msg.method === 'Network.responseReceived' && requests.has(p.requestId)) {
      Object.assign(requests.get(p.requestId), { response: p.response, type: p.type });
    } else if (msg.method === 'Network.loadingFinished' && requests.has(p.requestId)) {
      requests.get(p.requestId).end = p.timestamp;
    } else if (msg.method === 'Network.loadingFailed' && requests.has(p.requestId)) {
      Object.assign(requests.get(p.requestId), { end: p.timestamp, failed: p.errorText });
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });
    const result = await send('Runtime.evaluate', { expression: `(${TOUR.toString()})()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'tour failed');
    console.log(`tour: ${result.result.value.join(' → ')}`);
    await sleep(1500);
  } finally {
    ws.close();
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    } else proc.kill();
  }

  const redact = (name, value) => {
    if (/^authorization$/i.test(name)) return value.replace(/^(\w+)\s.+$/, '$1 <redacted>');
    if (/^(cookie|x-api-key)$/i.test(name)) return '<redacted>';
    return value;
  };
  const entries = [...requests.values()].filter((r) => r.response || r.failed).map((r) => ({
    startedDateTime: new Date(r.wallTime * 1000).toISOString(),
    time: r.end ? Math.round((r.end - r.start) * 1000 * 10) / 10 : 0,
    _resourceType: String(r.type || 'other').toLowerCase(),
    request: {
      method: r.request.method,
      url: r.request.url,
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(r.request.headers || {}).map(([name, value]) => ({ name, value: redact(name, value) })),
      queryString: [], cookies: [], headersSize: -1, bodySize: r.request.postData ? r.request.postData.length : 0,
      ...(r.request.postData ? { postData: { mimeType: 'application/json', text: r.request.postData } } : {}),
    },
    // Chrome reports 204s whose (empty) body is never read as ERR_ABORTED even though the
    // response arrived, so a received response wins over the failure.
    response: {
      status: r.response ? r.response.status : 0,
      statusText: r.response ? r.response.statusText || '' : r.failed,
      httpVersion: 'HTTP/1.1', headers: [], cookies: [],
      content: { size: 0, mimeType: r.response?.mimeType || '' },
      redirectURL: '', headersSize: -1, bodySize: -1,
    },
    cache: {}, timings: { send: 0, wait: 0, receive: 0 },
  }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ log: { version: '1.2', creator: { name: 'postboard capture-har', version: '1' }, pages: [], entries } }, null, 1));
  const hosts = [...new Set(entries.map((e) => new URL(e.request.url).host))];
  console.log(`wrote ${entries.length} requests to ${OUT}\nhosts: ${hosts.join(', ')}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
