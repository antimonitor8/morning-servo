import { chat, stepModels } from './openrouter.js';
import { mapLimit, clip, log } from './util.js';

export const SECTIONS = ['breakthroughs', 'robotics', 'beat', 'money', 'india', 'policy', 'other'];
export const SECTION_LABEL = {
  breakthroughs: 'Breakthroughs', robotics: 'Robotics Floor', beat: 'Your Beat',
  money: 'The Money', india: 'India Desk', policy: 'Policy', other: 'Elsewhere',
};

const HOUSE_STYLE = `House style: plain, specific and calm, like a good broadsheet. Short sentences. No hype words (revolutionary, game-changing, groundbreaking, unprecedented), no rhetorical questions, no exclamation marks, no emoji.`;

// ---------- Triage ----------

const triageSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['i', 'score', 'section', 'industry', 'task', 'funding'],
        properties: {
          i: { type: 'integer' },
          score: { type: 'integer', minimum: 0, maximum: 10 },
          section: { type: 'string', enum: SECTIONS },
          industry: { type: 'string' },
          task: { type: 'string' },
          funding: { type: 'boolean' },
        },
      },
    },
  },
};

export const triageSystem = (profile) => `You are the night editor of The Morning Servo, a daily AI and robotics newspaper written for one reader.

Reader profile:
${profile}

Score every item from 0 to 10 for how much it deserves a place in tomorrow's paper for this reader:
- 9-10: a major breakthrough, a very large funding round (over $100M), or a deployment that changes the field
- 7-8: important and clearly relevant to the reader
- 4-6: worth a one-line brief
- 1-3: marginal
- 0: off-topic (not about AI or robotics), a listicle, a deal or coupon, a podcast episode, or a vague opinion piece
Favour real deployments with numbers, concrete use cases in specific industries, robot learning and embodied AI, training data and data collection, research with clear results, funding rounds, and India's AI and robotics ecosystem. Penalise hype and minor product updates.

section: breakthroughs (research, models, benchmarks), robotics (robot products, deployments, hardware), beat (robot training data, egocentric video, teleoperation, data vendors, datasets), money (funding rounds, acquisitions, IPOs), india (India-specific news), policy (regulation, government), other.
industry: one short label for the industry the story applies to, such as Logistics, Automotive, Healthcare, Agriculture, Household, Retail, Construction, Textiles, Software, or General.
task: one short label for the task, such as Manipulation, Navigation, Inspection, Assembly, Coding, Customer support, or General.
funding: true only if the item reports a specific funding round, acquisition or IPO.

Return exactly one entry per item, using the item's index as i.`;

export const triageUser = (batch) => batch
  .map(({ it, i }) => `${i} | ${it.source} | ${it.title} | ${clip(it.snippet, 280)}`)
  .join('\n');

export async function triage(items, { batchSize, budget, profile, models }) {
  const cfg = stepModels('triage');
  const indexed = items.map((it, i) => ({ it, i }));
  const batches = [];
  for (let k = 0; k < indexed.length; k += batchSize) batches.push(indexed.slice(k, k + batchSize));
  const system = triageSystem(profile);
  const results = await mapLimit(batches, 4, async (batch, b) => {
    try {
      const r = await chat({ step: 'triage', ...cfg, models: models || cfg.models, system, user: triageUser(batch), schema: triageSchema, budget });
      return r.json.items;
    } catch (err) {
      log(`  triage batch ${b} failed: ${err.message}`);
      return [];
    }
  });
  const byIndex = new Map(results.flat().map((x) => [x.i, x]));
  return items.map((it, i) => ({ ...it, ...(byIndex.get(i) || { score: 0, section: 'other', industry: 'General', task: 'General', funding: false }) }));
}

// ---------- Selection (no LLM) ----------

export function select(scored, s) {
  const rank = (a, b) => b.score - a.score || b.also.length - a.also.length;
  const pool = [...scored].sort(rank);
  const top = [];
  const count = {};
  for (const it of pool) {
    if (top.length >= s.topStories) break;
    if (it.score < s.minTopScore) break;
    if ((count[it.section] || 0) >= (s.sectionCaps[it.section] ?? 2)) continue;
    top.push(it);
    count[it.section] = (count[it.section] || 0) + 1;
  }
  // Guarantee the reader's beat and India a slot when there's a decent candidate.
  for (const must of ['beat', 'india']) {
    if (top.some((t) => t.section === must)) continue;
    const cand = pool.find((it) => it.section === must && it.score >= s.minTopScore - 1 && !top.includes(it));
    if (cand && top.length) top[top.length - 1] = cand;
  }
  top.sort(rank);

  const used = new Set(top);
  // The Money table lists every deal, including ones that also made the top stories.
  const funding = pool.filter((it) => it.funding && it.score >= 3).slice(0, 25);
  const fundingSet = new Set(funding);
  let briefs = pool.filter((it) => !used.has(it) && !fundingSet.has(it) && it.score >= s.minBriefScore).slice(0, s.briefsMax);
  if (briefs.length < s.briefsMin) {
    briefs = pool.filter((it) => !used.has(it) && !fundingSet.has(it) && it.score > 0).slice(0, s.briefsMin);
  }
  return { top, briefs, funding };
}

// ---------- Writing ----------

const writeSchema = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'deck', 'body', 'why', 'hard', 'industry', 'task'],
  properties: {
    headline: { type: 'string' },
    deck: { type: 'string' },
    body: { type: 'array', items: { type: 'string' } },
    why: { type: 'string' },
    hard: { type: 'string' },
    industry: { type: 'array', items: { type: 'string' } },
    task: { type: 'array', items: { type: 'string' } },
  },
};

export const writeSystem = (profile) => `You write news stories for The Morning Servo, a daily AI and robotics newspaper for one reader.

Reader profile:
${profile}

${HOUSE_STYLE}
Use only facts in the source material. Never invent numbers, names, quotes or dates. If the source is thin, write less rather than pad.

Fields:
- headline: at most 14 words, says plainly what happened, sentence case
- deck: one sentence of at most 30 words with the most important detail the headline left out
- body: 2 or 3 paragraphs of 40 to 70 words each: what happened, the key numbers or how it works, then context
- why: one or two sentences on why this matters to this reader. Be concrete about consequences. Don't flatter the reader or mention them directly.
- hard: one sentence on the main caveat, open problem or thing that is still unproven
- industry: 1 or 2 short labels; task: 1 or 2 short labels`;

export const writeUser = (it, text) => `Section: ${SECTION_LABEL[it.section]}
Original headline: ${it.title}
Source: ${it.source}${it.also.length ? ` (also reported by ${it.also.map((a) => a.name).join(', ')})` : ''}
Feed summary: ${it.snippet}

Article text:
${text || '(The article text could not be fetched. Write a short story from the feed summary only.)'}`;

export async function writeStories(top, texts, { budget, profile, models }) {
  const cfg = stepModels('write');
  const system = writeSystem(profile);
  return mapLimit(top, 4, async (it, i) => {
    try {
      const r = await chat({ step: 'write', ...cfg, models: models || cfg.models, system, user: writeUser(it, texts[i]), schema: writeSchema, budget });
      return { ...r.json, written: true };
    } catch (err) {
      log(`  writing "${it.title}" failed: ${err.message}`);
      return null;
    }
  });
}

// ---------- The Money ----------

const moneySchema = {
  type: 'object', additionalProperties: false, required: ['rounds'],
  properties: {
    rounds: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['i', 'company', 'what', 'round', 'amount_usd_m', 'amount_text', 'lead', 'india'],
        properties: {
          i: { type: 'integer' },
          company: { type: 'string' },
          what: { type: 'string' },
          round: { type: 'string' },
          amount_usd_m: { type: ['number', 'null'] },
          amount_text: { type: 'string' },
          lead: { type: 'string' },
          india: { type: 'boolean' },
        },
      },
    },
  },
};

export async function extractMoney(funding, { budget }) {
  if (!funding.length) return [];
  const cfg = stepModels('money');
  const system = `Extract funding rounds, acquisitions and IPOs from news items about AI and robotics companies.
For each item that reports a specific deal, return:
- company: the company that raised money or was acquired
- what: what the company does, in at most 6 words
- round: the round (Seed, Series A, Series B, Acquisition, IPO, Debt, and so on)
- amount_usd_m: the amount in millions of US dollars as a number, converting other currencies at roughly current rates (1 USD = 88 INR, 1 EUR = 1.08 USD), or null if undisclosed
- amount_text: the amount as it should appear in a table, like "$210M", "₹150 Cr ($17M)" or "Undisclosed"
- lead: the lead investor or acquirer, or "Not disclosed"
- india: true if the company is based in India
Use only facts in the items. Skip items that don't report a specific deal.`;
  const user = funding.map((it, i) => `${i} | ${it.source} | ${it.title} | ${it.snippet}`).join('\n');
  try {
    const r = await chat({ step: 'money', ...cfg, system, user, schema: moneySchema, budget });
    return r.json.rounds
      .filter((x) => funding[x.i])
      .map((x) => ({ ...x, url: funding[x.i].link, source: funding[x.i].source }))
      .sort((a, b) => (b.amount_usd_m ?? -1) - (a.amount_usd_m ?? -1))
      .filter(uniqueCompany());
  } catch (err) {
    log(`  money extraction failed: ${err.message}`);
    return [];
  }
}

// Two outlets reporting one deal give two rows ("Robusta" and "Robusta Dev"); keep the first, largest one.
function uniqueCompany() {
  const seen = [];
  const key = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (row) => {
    const k = key(row.company);
    if (!k || seen.some((s) => s.startsWith(k) || k.startsWith(s))) return false;
    seen.push(k);
    return true;
  };
}

// ---------- THINK ----------

const str = { type: 'string' };
const ref = { type: 'object', additionalProperties: false, required: ['kind', 'n', 'label'], properties: { kind: { type: 'string', enum: ['story', 'brief'] }, n: { type: 'integer' }, label: str } };
const collision = {
  type: 'object', additionalProperties: false,
  required: ['a', 'b', 'headline', 'body', 'who_pays', 'data_needed', 'why_fail'],
  properties: { a: ref, b: ref, headline: str, body: str, who_pays: str, data_needed: str, why_fail: str },
};
const contrarian = {
  type: 'object', additionalProperties: false,
  required: ['story_n', 'consensus', 'against', 'bets_otherwise', 'settle_it'],
  properties: { story_n: { type: 'integer' }, consensus: str, against: { type: 'array', items: str }, bets_otherwise: str, settle_it: str },
};
const outside = {
  type: 'object', additionalProperties: false,
  required: ['field', 'headline', 'body', 'pull', 'why_helps', 'who_might'],
  properties: { field: str, headline: str, body: str, pull: str, why_helps: str, who_might: str },
};
const wildcard = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'changed', 'won', 'broke', 'your_move'],
  properties: { headline: str, changed: str, won: str, broke: str, your_move: str },
};

export async function think(stories, briefs, { budget, profile, sunday, pastCollisions, pastWildcards }) {
  const cfg = stepModels('think');
  const schema = {
    type: 'object', additionalProperties: false,
    required: sunday ? ['collision', 'contrarian', 'outside', 'wildcard'] : ['collision', 'contrarian'],
    properties: sunday ? { collision, contrarian, outside, wildcard } : { collision, contrarian },
  };
  const system = `You write the THINK page, the last page of The Morning Servo, a daily AI and robotics newspaper for one reader. Its job is to help the reader think outside the box and spot opportunities.

Reader profile:
${profile}

${HOUSE_STYLE}

The Collision: pick two items from today's paper that come from different sections and are not obviously related. Combine them into one concrete idea for a product, business, dataset or research direction. Be specific enough that someone could start on it.
- a, b: the two items (kind "story" or "brief", n is the item number shown, label is a short paraphrase of at most 9 words)
- headline: the idea in at most 22 words
- body: 2 or 3 sentences on how the two pieces fit together
- who_pays: who would pay for this, one sentence
- data_needed: what data it would need, one sentence
- why_fail: the most likely reason it fails, one sentence

The Contrarian Take: take the top story whose framing most people will accept without question.
- story_n: its number
- consensus: the view most readers will come away with, one sentence
- against: the three strongest arguments that the consensus is wrong, overhyped or headed somewhere unexpected; one or two sentences each
- bets_otherwise: who is betting the other way. Name only companies or groups that appear in today's items or that you are confident exist; otherwise say what kind of player would.
- settle_it: what evidence would settle the question, one sentence
${sunday ? `
Outside the Bubble: one well-established idea from a field outside AI (biology, ecology, materials, architecture, economics, history, logistics history, game design, medicine, music, and so on). Don't invent facts about the field.
- field: the field, one or two words
- headline: the idea, at most 12 words
- body: 2 or 3 sentences explaining it
- pull: one sentence starting with "What if" that maps it to robots or AI
- why_helps: one sentence; who_might: who might try it, one sentence

Wild Card: a weird but plausible scenario 5 to 8 years out that touches the reader's world (physical work, robot training data, India, or AI labs).
- headline: start with "It's 20XX." and state the scenario in one more sentence
- changed, won, broke: one sentence each
- your_move: a question to the reader about what they would need in place today` : ''}

Don't repeat or closely echo these recent ideas:
${[...pastCollisions, ...(pastWildcards || [])].map((x) => `- ${x}`).join('\n') || '- (none yet)'}`;

  const user = `Today's top stories:
${stories.map((s, i) => `Story ${i + 1} [${SECTION_LABEL[s.section]}] ${s.headline}: ${s.deck} Why it matters: ${s.why}`).join('\n')}

Today's briefs:
${briefs.map((b, i) => `Brief ${i + 1}: ${b.title}`).join('\n')}`;

  try {
    const r = await chat({ step: 'think', ...cfg, system, user, schema, budget, maxTokens: sunday ? 6000 : cfg.maxTokens });
    return r.json;
  } catch (err) {
    log(`  think failed: ${err.message}`);
    return null;
  }
}
