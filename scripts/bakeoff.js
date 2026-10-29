// Model bake-offs.
//   npm run bakeoff -- triage   rank the same items with each cheap model and compare to an Opus reference
//   npm run bakeoff -- write    write the same 3 stories with each writing model into a blind side-by-side page
import fs from 'node:fs';
import { loadEnv, settings, readerProfile, modelsConfig, readJson, writeJson, p, log, mapLimit } from './lib/util.js';
import { Budget } from './lib/openrouter.js';
import { fetchAll, dedupe, fullText } from './lib/news.js';
import { triage, select, writeStories, SECTION_LABEL } from './lib/steps.js';

loadEnv();
if (!process.env.OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set. Add it to .env.'); process.exit(1); }

const mode = process.argv[2];
const s = settings();
const cfg = modelsConfig().bakeoff;
const profile = readerProfile();
const dir = p('data/bakeoff');
fs.mkdirSync(dir, { recursive: true });

async function sampleItems() {
  const cache = readJson(`${dir}/items.json`, null);
  if (cache && Date.now() - cache.at < 12 * 3600_000) return cache.items;
  const { items: raw } = await fetchAll(s.windowHours);
  const items = dedupe(raw).slice(0, 200);
  writeJson(`${dir}/items.json`, { at: Date.now(), items });
  return items;
}

const rankIds = (scored) => [...scored].map((x, i) => ({ ...x, _i: i })).sort((a, b) => b.score - a.score || a._i - b._i).map((x) => x.id);
const overlap = (a, b, n) => a.slice(0, n).filter((id) => b.slice(0, n).includes(id)).length;

async function runTriage(model, items) {
  const budget = new Budget(2);
  const t0 = Date.now();
  const scored = await triage(items, { batchSize: s.triageBatchSize, budget, profile, models: [model] });
  const returned = budget.calls.length ? scored.filter((x) => x.i !== undefined).length : 0;
  const res = { model, scored, cost: budget.spent, seconds: (Date.now() - t0) / 1000, returned };
  writeJson(`${dir}/triage-${model.replace('/', '_')}.json`, res);
  return res;
}

if (mode === 'triage') {
  const items = await sampleItems();
  log(`Bake-off on ${items.length} items. Reference: ${cfg.triageReference}`);
  const ref = await runTriage(cfg.triageReference, items);
  const refRank = rankIds(ref.scored);
  const refById = new Map(ref.scored.map((x) => [x.id, x]));
  const rows = [];
  for (const model of cfg.triageCandidates) {
    log(`Running ${model}`);
    const r = await runTriage(model, items);
    const rank = rankIds(r.scored);
    const absErr = r.scored.reduce((n, x) => n + Math.abs(x.score - (refById.get(x.id)?.score ?? 0)), 0) / items.length;
    const secAgree = r.scored.filter((x) => x.section === refById.get(x.id)?.section).length / items.length;
    rows.push({
      model,
      top10: overlap(rank, refRank, 10),
      top20: overlap(rank, refRank, 20),
      scoreErr: absErr.toFixed(2),
      sections: `${Math.round(secAgree * 100)}%`,
      coverage: `${Math.round((r.returned / items.length) * 100)}%`,
      cost: `$${r.cost.toFixed(4)}`,
      perEdition: `$${((r.cost / items.length) * s.maxItemsToTriage).toFixed(4)}`,
      seconds: r.seconds.toFixed(0),
    });
  }
  const header = '| Model | Top-10 match | Top-20 match | Avg score gap | Same section | Items scored | Cost (this run) | Est. per edition | Seconds |\n|---|---|---|---|---|---|---|---|---|';
  const table = rows.map((r) => `| ${r.model} | ${r.top10}/10 | ${r.top20}/20 | ${r.scoreErr} | ${r.sections} | ${r.coverage} | ${r.cost} | ${r.perEdition} | ${r.seconds} |`).join('\n');
  const refTop = refRank.slice(0, 10).map((id, i) => `${i + 1}. [${refById.get(id).score}] ${refById.get(id).title}`).join('\n');
  const md = `# Triage bake-off\n\n${items.length} items. Reference model: ${cfg.triageReference} (cost $${ref.cost.toFixed(4)}).\n\n${header}\n${table}\n\n## Reference top 10\n\n${refTop}\n`;
  fs.writeFileSync(`${dir}/triage-report.md`, md);
  console.log('\n' + md);
} else if (mode === 'write') {
  const items = await sampleItems();
  const refFile = `${dir}/triage-${cfg.triageReference.replace('/', '_')}.json`;
  let scored = readJson(refFile, null)?.scored;
  if (!scored) {
    log('No triage reference found; triaging with the default model first');
    scored = await triage(items, { batchSize: s.triageBatchSize, budget: new Budget(1), profile });
  }
  const picks = select(scored, s).top.slice(0, 3);
  const texts = await mapLimit(picks, 3, (it) => fullText(it.link));
  const versions = {};
  const costs = {};
  for (const model of cfg.writeCandidates) {
    log(`Writing with ${model}`);
    const budget = new Budget(1);
    versions[model] = await writeStories(picks, texts, { budget, profile, models: [model] });
    costs[model] = budget.spent;
  }
  const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const story = (w) => w ? `<span class="k">Story</span><h3>${esc(w.headline)}</h3><p class="d">${esc(w.deck)}</p>${w.body.map((b) => `<p>${esc(b)}</p>`).join('')}<p class="w"><b>Why it matters</b> ${esc(w.why)}</p><p class="w"><b>What's still hard</b> ${esc(w.hard)}</p>` : '<p><i>This model failed to write the story.</i></p>';
  const key = [];
  const blocks = picks.map((it, i) => {
    const order = [...cfg.writeCandidates].sort(() => Math.random() - 0.5);
    key.push(`Story ${i + 1}: ${order.map((m, j) => `${String.fromCharCode(65 + j)} = ${m}`).join(', ')}`);
    return `<section><p class="src">Story ${i + 1} · Source: <a href="${esc(it.link)}">${esc(it.title)}</a> (${esc(it.source)})${texts[i] ? '' : ' · full text unavailable'}</p><div class="pair">${order.map((m, j) => `<article><div class="v">Version ${String.fromCharCode(65 + j)}</div>${story(versions[m][i])}</article>`).join('')}</div></section>`;
  });
  const per = cfg.writeCandidates.map((m) => `${m}: $${costs[m].toFixed(4)} for 3 stories, about $${((costs[m] / 3) * s.topStories).toFixed(3)} per edition`);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Writing bake-off</title>
<style>body{font:16px/1.5 Georgia,serif;max-width:1100px;margin:0 auto;padding:24px 16px;background:#f7f6f2;color:#16171a}h1{font-weight:400}section{border-top:3px double #16171a;padding:14px 0 24px}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}article{background:#fff;padding:16px;border:1px solid #ccc}.v{font:700 12px sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#1d3f8f}h3{font-weight:400;font-size:1.4rem;margin:6px 0}.d{font-style:italic;color:#4a4c52}.w{border-top:1px solid #ccc;padding-top:6px;font-size:.95rem}.src{font:13px sans-serif;color:#4a4c52}.k{display:none}details{margin-top:24px;font:14px sans-serif}</style>
<h1>Writing bake-off</h1><p>Read each pair and note which version you'd rather read in your paper. The model names are hidden until you open the key at the bottom.</p>
${blocks.join('')}
<details><summary>Show which model wrote which version</summary><ul>${key.map((k) => `<li>${esc(k)}</li>`).join('')}</ul><ul>${per.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></details>`;
  fs.writeFileSync(`${dir}/write-report.html`, html);
  log(`Wrote ${dir}/write-report.html`);
  per.forEach((x) => log(x));
} else {
  console.log('Usage: npm run bakeoff -- triage | write');
}
