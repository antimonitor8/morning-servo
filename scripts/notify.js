// Sends the 8:00 push for today's edition to every subscription in PUSH_SUBSCRIPTION.
import webpush from 'web-push';
import { loadEnv, settings, localDate, readJson, p, log } from './lib/util.js';

loadEnv();
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SUBSCRIPTION, SITE_URL } = process.env;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !PUSH_SUBSCRIPTION) {
  console.error('Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and PUSH_SUBSCRIPTION first.');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:noreply@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const s = settings();
const { iso: date, weekday } = localDate(s.timezone);
const edition = readJson(p(`site/editions/${date}.json`), null);
const url = SITE_URL || './';

const payload = edition && edition.stories.length
  ? {
    title: `${weekday}'s edition is ready`,
    body: `${edition.stories[0].headline} · ${edition.stories.length - 1} more stories · ${edition.readMinutes} min read`,
    url,
  }
  : { title: 'No edition today', body: "Today's paper failed to build. Check the GitHub Actions log.", url };

const parsed = JSON.parse(PUSH_SUBSCRIPTION);
const subs = Array.isArray(parsed) ? parsed : [parsed];
let failed = 0;
for (const sub of subs) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal' });
    log('Sent:', payload.title);
  } catch (err) {
    failed++;
    log(`Push failed (${err.statusCode || ''}): ${err.body || err.message}`);
    if (err.statusCode === 404 || err.statusCode === 410) log('This subscription has expired. Re-enable notifications in the app and update PUSH_SUBSCRIPTION.');
  }
}
process.exit(failed === subs.length ? 1 : 0);
