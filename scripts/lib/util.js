import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const p = (...parts) => path.join(ROOT, ...parts);

export function loadEnv() {
  try { process.loadEnvFile(p('.env')); } catch { /* no .env: rely on real env vars */ }
}

export const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
export const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};

export const settings = () => readJson(p('config/settings.json'));
export const modelsConfig = () => readJson(p('config/models.json'));

export function readerProfile() {
  if (fs.existsSync(p('config/profile.local.md'))) return fs.readFileSync(p('config/profile.local.md'), 'utf8').trim();
  if (process.env.READER_PROFILE) return process.env.READER_PROFILE.trim();
  return fs.readFileSync(p('config/profile.md'), 'utf8').trim();
}

export const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// Date parts in the paper's timezone (IST), so the edition date matches the reader's morning.
export function localDate(tz, d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const clip = (s, n) => {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

const STOP = new Set('a an the of to in on for and or with by at from as is are was be its it this that new how why what says say after over into up out about than more ai'.split(' '));
export const titleTokens = (t) => new Set(
  (t || '').toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w)),
);
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
