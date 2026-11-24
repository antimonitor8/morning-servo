import { chat, stepModels } from './openrouter.js';
import { mapLimit, clip, log, titleTokens, sameStory } from './util.js';

export const SECTIONS = ['robotics', 'ai', 'research', 'india', 'other'];
export const SECTION_LABEL = {
  robotics: 'Robotics', ai: 'AI', research: 'Research & Data', india: 'India', other: 'Elsewhere',
};

const HOUSE_STYLE = `House style: plain, specific and calm, like a good broadsheet. Short sentences.
Write for a smart, curious reader who is not an engineer or researcher. Explain every technical term in everyday words the first time it appears, spell out acronyms, and use a quick everyday comparison when an idea is abstract. Never assume the reader already knows the background: say in a few words what the thing is before saying what changed. No hype words (revolutionary, game-changing, groundbreaking, unprecedented), no rhetorical questions, no exclamation marks, no emoji.`;

// ---------- Triage ----------

const triageSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['i', 'score', 'section', 'industry', 'task', 'funding', 'fun'],
        properties: {
          i: { type: 'integer' },
          score: { type: 'integer', minimum: 0, maximum: 10 },
          section: { type: 'string', enum: SECTIONS },
          industry: { type: 'string' },
          task: { type: 'string' },
          funding: { type: 'boolean' },
          fun: { type: 'boolean' },
        },
      },
    },
  },
};

export const triageSystem = (profile, recentHeadlines = []) => `You are the night editor of The Morning Servo, a daily AI and robotics newspaper written for one reader.

Reader profile:
${profile}

Score every item from 0 to 10 for how noteworthy it is: would a smart, non-technical person working in AI and robotics still care about it in six months?
- 9-10: news the whole industry will talk about this week: a very large funding round (over $100M), a major launch from a leading company, a large real-world deployment, a major policy decision, or a result that clearly changes what robots or AI can do
- 7-8: clearly significant news with concrete facts: real customers, real numbers, a notable launch, deal or decision
- 4-6: worth a one-line mention
- 1-3: marginal: small product updates, incremental tweaks, announcements without substance
- 0: off-topic (not about AI or robotics), a listicle, a deal or coupon, a podcast episode, or a vague opinion piece
Research papers: most papers are small improvements to a method and score 3 to 5. Only a paper that shows a big new capability, a major new dataset, or a surprising finding scores 7 or more.
Use the reader profile only to break ties between equally noteworthy items. Never raise a score just because an item touches the reader's niche (egocentric video, robot training data, data collection, gloves, wrist cameras, grippers, touch sensing).
Repetition: the paper's headlines from the last few days are listed below. If an item is another example of the same theme with no major new fact (for example, yet another method for turning human video into robot training data), lower its score by 2 or 3. A new fact such as a big funding round, a major customer or a clear result keeps its score.

section: robotics (news about robot companies, products, deployments, hardware, self-driving cars, drones, and robotics policy), ai (news about AI companies, models, products, chips, and AI policy and regulation), research (academic papers, preprints, benchmarks, datasets and lab results in AI or robotics, including methods for robot training data), india (any news about Indian AI or robotics companies, investors or government, including funding rounds of Indian startups; this overrides the others), other.
industry: one short label for the industry the story applies to, such as Logistics, Automotive, Healthcare, Agriculture, Household, Retail, Construction, Textiles, Software, or General.
task: one short label for the task, such as Manipulation, Navigation, Inspection, Assembly, Coding, Customer support, or General.
funding: true only if the item reports a specific funding round, acquisition or IPO.
fun: true if the item is a playful, surprising or creative experiment that uses AI or robots: a hobbyist build, a weird demo, an art or music project, a game, a clever hack, or a research stunt. It must involve AI or robots. Give fun items a score of at least 3 even if they matter little to the reader's work.

Return exactly one entry per item, using the item's index as i.

Headlines from recent editions:
${recentHeadlines.map((h) => `- ${h}`).join('\n') || '- (none yet)'}`;

export const triageUser = (batch) => batch
  .map(({ it, i }) => `${i} | ${it.source} | ${it.title} | ${clip(it.snippet, 280)}`)
  .join('\n');

export async function triage(items, { batchSize, budget, profile, models, recentHeadlines }) {
  const cfg = stepModels('triage');
  const indexed = items.map((it, i) => ({ it, i }));
  const batches = [];
  for (let k = 0; k < indexed.length; k += batchSize) batches.push(indexed.slice(k, k + batchSize));
  const system = triageSystem(profile, recentHeadlines);
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
  // Several outlets often cover one event under different headlines ("Nvidia reinstates Huang",
  // "Jensen Huang is back"). Treat two items as the same topic when they share two distinctive words.
  const GENERIC = new Set(['ai', 'robot', 'robots', 'robotics', 'model', 'models', 'startup', 'startups', 'raises', 'new', 'company', 'india', 'indian', 'launches', 'funding', 'million', 'billion', 'data']);
  const tok = new Map(pool.map((it) => [it, titleTokens(it.title)]));
  const sameTopic = (a, b) => {
    const ta = tok.get(a), tb = tok.get(b);
    let shared = 0;
    for (const x of ta) if (tb.has(x) && !GENERIC.has(x)) shared++;
    return shared >= 2 || sameStory(ta, tb);
  };
  const firstWord = (t) => t.split(/\s+/)[0].toLowerCase();
  const news = (section) => {
    const picks = [];
    for (const it of pool) {
      if (picks.length >= s.newsPerSection) break;
      if (it.score < s.minNewsScore) break;
      if (it.role || it.section !== section) continue;
      if (picks.some((t) => sameTopic(t, it) || (t.funding && it.funding && firstWord(t.title) === firstWord(it.title)))) continue;
      picks.push(it);
    }
    return picks;
  };
  // Full write-ups: the biggest robotics news first, then the biggest AI news.
  const top = [...news('robotics'), ...news('ai')];
  const covered = (it, list) => list.some((t) => sameTopic(t, it) || firstWord(t.title) === firstWord(it.title));
  // Research and India get one page each with short summaries; the writer picks the best of these.
  const research = pool.filter((it) => !it.role && it.section === 'research' && it.score >= s.minDigestScore).slice(0, s.researchCandidates);
  const india = pool.filter((it) => !it.role && it.section === 'india' && it.score >= s.minDigestScore && !covered(it, top)).slice(0, s.indiaCandidates);

  const used = new Set([...top, ...research, ...india]);
  // The Money table lists every deal, including ones that also made the top stories.
  // Any real AI or robotics deal qualifies; relevance to the reader only orders them.
  const funding = pool.filter((it) => it.funding && it.score >= 2).slice(0, 45);
  const fundingSet = new Set(funding);
  // Candidates for The Playground; the writer picks the best few.
  const fun = pool.filter((it) => it.fun && !used.has(it) && !fundingSet.has(it) && it.score >= 2).slice(0, 10);
  const funSet = new Set(fun);
  // Research papers that didn't make the Research page are left out rather than listed as briefs.
  const briefable = (it) => !used.has(it) && !fundingSet.has(it) && !funSet.has(it) && it.role !== 'fun' && it.section !== 'research';
  // One brief per topic, and nothing the stories or the India page already cover.
  const pickBriefs = (minScore, max) => {
    const out = [];
    for (const it of pool) {
      if (out.length >= max) break;
      if (!briefable(it) || it.score < minScore) continue;
      if ([...top, ...india, ...out].some((t) => sameTopic(t, it))) continue;
      out.push(it);
    }
    return out;
  };
  let briefs = pickBriefs(s.minBriefScore, s.briefsMax);
  if (briefs.length < s.briefsMin) briefs = pickBriefs(1, s.briefsMin);
  return { top, research, india, briefs, funding, fun };
}

// ---------- Writing ----------

const writeSchema = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'takeaway', 'deck', 'body', 'why', 'hard', 'terms', 'industry', 'task'],
  properties: {
    headline: { type: 'string' },
    takeaway: { type: 'string' },
    terms: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['term', 'meaning'], properties: { term: { type: 'string' }, meaning: { type: 'string' } } },
    },
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
- headline: at most 14 words, says plainly what happened, sentence case, no jargon. Name companies, but never names of methods, models or techniques the reader wouldn't know.
- takeaway: the short version in two sentences, at most 45 words, that someone outside the field fully understands: what happened, and what it means in practice. No technical terms at all.
- deck: one sentence of at most 30 words with the most important detail the headline left out
- body: 2 or 3 paragraphs of 40 to 70 words each: what happened, the key numbers or how it works, then context
- why: one or two sentences on why this matters to this reader. Be concrete about consequences. Don't flatter the reader or mention them directly.
- hard: one sentence on the main caveat, open problem or thing that is still unproven
- terms: up to 4 technical terms, product types or acronyms used in the story that a non-specialist might not know, starting with the most basic idea the story depends on (for example what a "policy" or "foundation model" is), each with a plain one-sentence meaning (at most 25 words). Empty if there are none.
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

// ---------- The Playground ----------

const playgroundSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['n', 'headline', 'body', 'why_cool', 'maker'],
        properties: { n: { type: 'integer' }, headline: { type: 'string' }, body: { type: 'string' }, why_cool: { type: 'string' }, maker: { type: 'string' } },
      },
    },
  },
};

export async function playground(candidates, texts, { budget, count }) {
  if (!candidates.length) return [];
  const cfg = stepModels('playground');
  const system = `You write The Playground, the light-hearted page of The Morning Servo, a daily AI and robotics newspaper. It shows the fun, surprising and creative things people are building with AI and robots, because these experiments show what is newly possible.

Pick the ${count} most delightful items from the candidates. Prefer things people actually built and showed working over announcements. Prefer variety: mix robots, AI software, art, games and hardware hacks. Skip anything that isn't really about AI or robots, and anything grim.

For each pick:
- n: the candidate number
- headline: at most 12 words, playful but clear about what was built
- body: 2 or 3 short sentences on what they made and how it works. Warm and a little wry, like a friend telling you about something cool they saw. Use only facts from the source.
- why_cool: one sentence on what this shows is now possible, or what it hints at for the future
- maker: who built it (a person, team, lab or company), or "Unknown" if the source doesn't say
No hype words, no exclamation marks, no emoji.`;
  const user = candidates.map((it, i) => `Candidate ${i + 1} | ${it.source} | ${it.title}\n${texts[i] || it.snippet}`).join('\n\n');
  try {
    const r = await chat({ step: 'playground', ...cfg, system, user, schema: playgroundSchema, budget });
    return r.json.items
      .filter((x) => candidates[x.n - 1])
      .slice(0, count)
      .map((x) => ({ headline: x.headline, body: x.body, why: x.why_cool, maker: x.maker, url: candidates[x.n - 1].link, source: candidates[x.n - 1].source }));
  } catch (err) {
    log(`  playground failed: ${err.message}`);
    return [];
  }
}

// ---------- Research & Data and India pages ----------

const digestSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['n', 'headline', 'what', 'why', 'who'],
        properties: { n: { type: 'integer' }, headline: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' }, who: { type: 'string' } },
      },
    },
  },
};

const DIGEST_BRIEF = {
  research: (count) => `You write the Research & Data page of The Morning Servo, a daily AI and robotics newspaper. The page sums up the most important new research papers, datasets and lab results in a few lines each, for a reader who is not a researcher.

Pick at most ${count} candidates that matter most: a big new capability, a major dataset, or a surprising finding. Skip small improvements to a method. Picking fewer is fine; picking none is fine on a slow day. Never pick two that make the same point.

For each pick:
- n: the candidate number
- headline: at most 12 words on what robots or AI can now do, or what was found, in everyday words. No names of methods, models or benchmarks.
- what: two short sentences on what the researchers did and what they found, with at most one key number. Write it so someone with no technical background understands it: no technical terms such as policy, point tracker, vision-language model, fine-tuning, benchmark, simulation-to-real or embedding. Describe what the thing does instead (for example "the software that decides how the robot moves" rather than "policy").
- why: one sentence on why it matters in practice: what it could make cheaper, faster, safer or possible
- who: the lab, university or company behind it, or "Unknown" if the source doesn't say`,
  india: (count) => `You write the India page of The Morning Servo, a daily AI and robotics newspaper. The page covers the most important news about India's AI and robotics ecosystem in a few lines each.

Pick at most ${count} candidates that matter most: funding, government policy, big launches, deployments, and manufacturing. Only pick items about AI or robotics; skip space, fintech and other tech that doesn't involve AI or robots. Skip listicles, events and minor announcements. Picking fewer is fine. Never pick two about the same news.

For each pick:
- n: the candidate number
- headline: at most 12 words saying plainly what happened
- what: two short sentences on what happened, with the key numbers
- why: one sentence on why it matters for AI or robotics in India
- who: the main company, agency or organisation involved`,
};

export async function digest(kind, candidates, texts, { budget, count }) {
  if (!candidates.length) return [];
  const cfg = stepModels('write');
  const system = `${DIGEST_BRIEF[kind](count)}

${HOUSE_STYLE}
Use only facts from the source. Never invent numbers, names or dates.`;
  const user = candidates.map((it, i) => `Candidate ${i + 1} | ${it.source} | ${it.title}\n${texts[i] || it.snippet}`).join('\n\n');
  try {
    const r = await chat({ step: kind, ...cfg, system, user, schema: digestSchema, budget });
    const seen = new Set();
    return r.json.items
      .filter((x) => candidates[x.n - 1] && !seen.has(x.n) && seen.add(x.n))
      .slice(0, count)
      .map((x) => {
        const it = candidates[x.n - 1];
        return { headline: x.headline, what: x.what, why: x.why, who: x.who, url: it.link, source: it.source, title: it.title };
      });
  } catch (err) {
    log(`  ${kind} page failed: ${err.message}`);
    return [];
  }
}

// ---------- The Money ----------

const moneySchema = {
  type: 'object', additionalProperties: false, required: ['rounds'],
  properties: {
    rounds: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['i', 'company', 'what', 'sector', 'round', 'amount_usd_m', 'amount_text', 'lead', 'india'],
        properties: {
          i: { type: 'integer' },
          sector: { type: 'string', enum: ['robotics', 'ai', 'deeptech'] },
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

export async function extractMoney(funding, { budget, pastCompanies = [] }) {
  if (!funding.length) return [];
  const cfg = stepModels('money');
  const system = `Extract funding rounds, acquisitions and IPOs from news items about AI and robotics companies.
For each item that reports a specific deal, return:
- company: the company that raised money or was acquired
- what: what the company does, in at most 6 words
- round: the round (Seed, Series A, Series B, Acquisition, IPO, Debt, and so on), or "Funding" if the item doesn't say
- amount_usd_m: the amount in millions of US dollars as a number, converting other currencies at roughly current rates (1 USD = 88 INR, 1 EUR = 1.08 USD), or null if undisclosed
- amount_text: the amount as it should appear in a table, like "$210M", "₹150 Cr ($17M)" or "Undisclosed"
- lead: the lead investor or acquirer, or "Not disclosed"
- india: true if the company is based in India
- sector: robotics (robots, drones, autonomous vehicles, physical AI, robot data), ai (AI models, AI software, AI chips and infrastructure), or deeptech (other hard tech such as space, defence tech, biotech platforms or semiconductors)
Use only facts in the items. Skip an item if it doesn't report a specific deal, if the company isn't named, if it's a venture fund raising money rather than a company, or if the company isn't in AI, robotics or deep tech (skip consumer brands, clinics, food, retail and generic marketplaces).`;
  const user = funding.map((it, i) => `${i} | ${it.source} | ${it.title} | ${it.snippet}`).join('\n');
  try {
    const r = await chat({ step: 'money', ...cfg, system, user, schema: moneySchema, budget });
    return r.json.rounds
      .filter((x) => funding[x.i] && !/^(not named|unnamed|undisclosed|unknown)/i.test(x.company.trim()))
      .map((x) => ({ ...x, round: /undisclosed|unknown/i.test(x.round) ? 'Funding' : x.round }))
      .map((x) => ({ ...x, url: funding[x.i].link, source: funding[x.i].source }))
      .sort((a, b) => (b.amount_usd_m ?? -1) - (a.amount_usd_m ?? -1))
      .filter(uniqueCompany(pastCompanies));
  } catch (err) {
    log(`  money extraction failed: ${err.message}`);
    return [];
  }
}

// Two outlets reporting one deal give two rows ("Robusta" and "Robusta Dev"); keep the first, largest one.
// Companies already listed in recent editions are dropped too, so a deal never repeats on a later day.
function uniqueCompany(pastCompanies = []) {
  const seen = pastCompanies.map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
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
