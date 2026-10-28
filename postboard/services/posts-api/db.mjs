// Local SQLite store. JSONPlaceholder accepts writes but never persists them, so edits,
// pins, deletions and new posts are kept here and overlaid on the upstream data.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = path.resolve(process.env.DB_PATH || 'data/posts.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
  create table if not exists posts (
    id integer primary key,
    user_id integer,
    title text,
    body text,
    pinned integer not null default 0,
    indexed integer not null default 0,
    deleted integer not null default 0,
    updated_at text
  )
`);

// ids below 1000 mirror JSONPlaceholder posts; local-only posts start at 1000
export const LOCAL_ID_START = 1000;
