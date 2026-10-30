// Builds today's edition: fetch → dedupe → triage → select → write → money → think → save.
import fs from 'node:fs';
import { loadEnv, settings, readerProfile, localDate, readJson, writeJson, p, log, mapLimit } from './lib/util.js';
import { Budget } from './lib/openrouter.js';
import { fetchAll, dedupe, fullText } from './lib/news.js';
import { triage, select, writeStories, extractMoney, think, playground, SECTION_LABEL } from './lib/steps.js';

loadEnv();
if (!process.env.OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set. Add it to .env.'); process.exit(1); }

const s = settings();
const profile = readerProfile();
const budget = new Budget(s.maxCostPerEditionUsd);
const { iso: date, weekday } = localDate(s.timezone);
const sunday = weekday === 'Sunday' || process.env.FORCE_SUNDAY === '1';

// Several scheduled runs try each morning; only the first one prints.
if (fs.existsSync(p(`site/editions/${date}.json`)) && process.env.FORCE !== '1') {
  log(`Edition for ${date} already exists; nothing to do. Set FORCE=1 to reprint.`);
  process.exit(0);
}

// If anything stalls, fail loudly with the step it was on instead of hanging until GitHub's limit.
let stage = 'start';
setTimeout(() => { log(`Gave up after 12 minutes during: ${stage}`); process.exit(1); }, 12 * 60_000).unref();

const indexFile = p('site/editions/index.json');
const index = readJson(indexFile, []).filter((e) => e.date !== date);
const recent = index.slice(0, 6).map((e) => readJson(p(`site/editions/${e.date}.json`), null)).filter(Boolean);
const seen = readJson(p('data/seen.json'), []).filter((x) => x.date >= dateDaysAgo(date, 5) && x.date !== date);

log(`Edition for ${weekday} ${date}${sunday ? ' (Sunday)' : ''}`);

// 1. Fetch
stage = 'fetch';
const { items: raw, report } = await fetchAll(s.windowHours);
for (const r of report) if (r.error) log(`  source failed: ${r.source}: ${r.error}`);
log(`Fetched ${raw.length} items from ${report.filter((r) => !r.error).length}/${report.length} sources`);

// 2. Dedupe
stage = 'dedupe';
const items = dedupe(raw, seen.map((x) => x.title), seen.map((x) => x.link)).slice(0, s.maxItemsToTriage);
log(`${items.length} unique new items after dedupe`);

// 3. Triage
stage = 'triage';
const scored = await triage(items, { batchSize: s.triageBatchSize, budget, profile });
log(`Triage done ($${budget.spent.toFixed(3)} so far)`);

// 4. Select
stage = 'select';
const { top, briefs, funding, fun } = select(scored, s);
log(`Selected ${top.length} top stories, ${briefs.length} briefs, ${funding.length} funding items, ${fun.length} playground candidates`);

// 5. Write the top stories from full article text
stage = 'full text and writing';
const texts = await mapLimit(top, 5, (it) => fullText(it.link));
log(`Fetched full text for ${texts.filter(Boolean).length}/${top.length} stories`);
const written = await writeStories(top, texts, { budget, profile });
const stories = [];
const demoted = [];
top.forEach((it, i) => {
  const w = written[i];
  if (!w) { demoted.push(it); return; }
  stories.push({
    id: it.id,
    section: it.section,
    kicker: SECTION_LABEL[it.section],
    headline: w.headline,
    deck: w.deck,
    body: w.body,
    why: w.why,
    hard: w.hard,
    tags: { industry: w.industry, task: w.task },
    score: it.score,
    sources: [{ name: it.source, url: it.link }, ...it.also],
  });
});
log(`Wrote ${stories.length} stories ($${budget.spent.toFixed(3)} so far)`);

// 6. The Money
stage = 'money';
const pastCompanies = recent.flatMap((e) => e.money?.rounds?.map((r) => r.company) || []);
const rounds = await extractMoney(funding, { budget, pastCompanies });
const totalM = rounds.reduce((sum, r) => sum + (r.amount_usd_m || 0), 0);

// 6b. The Playground
stage = 'playground';
const funTexts = await mapLimit(fun, 5, (it) => (it.link.includes('news.google.com') ? '' : fullText(it.link).then((t) => t.slice(0, 2500))));
const play = await playground(fun, funTexts, { budget, count: s.playgroundItems });
log(`Playground: ${play.length} items`);

// 7. THINK
stage = 'think';
const briefList = [...demoted, ...briefs].slice(0, s.briefsMax);
const pastCollisions = recent.map((e) => e.think?.collision?.headline).filter(Boolean);
const pastWildcards = recent.map((e) => e.think?.wildcard?.headline).filter(Boolean);
const thinkOut = stories.length >= 3
  ? await think(stories, briefList, { budget, profile, sunday, pastCollisions, pastWildcards })
  : null;
if (thinkOut && sunday) {
  thinkOut.week = recent
    .filter((e) => e.think?.collision)
    .map((e) => ({ date: e.date, weekday: e.weekday, headline: e.think.collision.headline }))
    .reverse();
}

// 8. Save
stage = 'save';
const words = stories.reduce((n, st) => n + [st.deck, ...st.body, st.why, st.hard].join(' ').split(/\s+/).length, 0)
  + briefList.length * 15 + play.length * 70 + (thinkOut ? (sunday ? 700 : 380) : 0);
const edition = {
  date,
  weekday,
  sunday,
  number: readJson(p(`site/editions/${date}.json`), null)?.number || index.length + 1,
  paper: s.paperName,
  readMinutes: Math.max(3, Math.round(words / 230)),
  stories,
  briefs: briefList.map((b) => ({ kicker: SECTION_LABEL[b.section], headline: b.title, url: b.link, source: b.source })),
  money: { rounds, totalUsdM: Math.round(totalM) },
  playground: play,
  think: thinkOut,
  cost: { usd: +budget.spent.toFixed(4), cap: s.maxCostPerEditionUsd, steps: budget.byStep() },
  sources: { fetched: raw.length, unique: items.length, feeds: report.length, failedFeeds: report.filter((r) => r.error).map((r) => r.source) },
  generatedAt: new Date().toISOString(),
};
writeJson(p(`site/editions/${date}.json`), edition);
writeJson(indexFile, [{ date, weekday, number: edition.number, lead: stories[0]?.headline || '', stories: stories.length, readMinutes: edition.readMinutes, costUsd: edition.cost.usd }, ...index]
  .sort((a, b) => b.date.localeCompare(a.date)));
writeJson(p('data/seen.json'), [...seen, ...top, ...briefs, ...funding, ...fun].map((x) => ({ date: x.date || date, title: x.title, link: x.link })));

log(`Saved edition No. ${edition.number}: ${stories.length} stories, ${edition.briefs.length} briefs, ${rounds.length} rounds, think: ${thinkOut ? 'yes' : 'no'}`);
log(`Cost: $${budget.spent.toFixed(4)}`, JSON.stringify(edition.cost.steps));

function dateDaysAgo(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Open keep-alive connections from article fetches can hold the process open; the work is done.
process.exit(0);
