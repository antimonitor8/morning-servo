// Sends the morning push for today's edition, at most once a day.
// Runs from the 8:00 schedule (and a backup), and from the edition job when the paper prints late.
import webpush from 'web-push';
import { loadEnv, settings, localDate, readJson, writeJson, p, log } from './lib/util.js';

loadEnv();
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SUBSCRIPTION, SITE_URL } = process.env;

const s = settings();
const { iso: date, weekday } = localDate(s.timezone);
const istHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const sentFile = p('data/notified.json');
const sent = readJson(sentFile, {});

if (sent.date === date) { log(`Already sent today's notification at ${sent.at}.`); process.exit(0); }
if (istHour < 8 && process.env.FORCE !== '1') { log('Before 8:00 IST; the 8:00 run will send it.'); process.exit(0); }
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !PUSH_SUBSCRIPTION) {
  log('No phone is connected yet (PUSH_SUBSCRIPTION is empty). Skipping the notification.');
  process.exit(0);
}

const edition = readJson(p(`site/editions/${date}.json`), null);
let payload;
if (edition?.stories.length) {
  payload = {
    title: `${weekday}'s edition is ready`,
    body: `${edition.stories[0].headline} · ${edition.stories.length - 1} more stories · ${edition.readMinutes} min read`,
  };
} else if (istHour >= 10) {
  payload = { title: 'No edition today', body: "Today's paper failed to print. Check the GitHub Actions log." };
} else {
  log("Today's edition isn't ready yet; the edition job will send the notification when it prints.");
  process.exit(0);
}
payload.url = SITE_URL || './';

webpush.setVapidDetails(VAPID_SUBJECT || SITE_URL || 'mailto:noreply@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const parsed = JSON.parse(PUSH_SUBSCRIPTION);
const subs = Array.isArray(parsed) ? parsed : [parsed];
let delivered = 0;
for (const sub of subs) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal' });
    delivered++;
    log('Sent:', payload.title);
  } catch (err) {
    log(`Push failed (${err.statusCode || ''}): ${err.body || err.message}`);
    if (err.statusCode === 404 || err.statusCode === 410) log('This phone subscription has expired. Turn notifications on again in the app and send the new device code.');
  }
}
if (delivered) writeJson(sentFile, { date, at: new Date().toISOString() });
process.exit(delivered ? 0 : 1);
