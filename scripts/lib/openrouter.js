import { modelsConfig, log } from './util.js';

export class BudgetExceeded extends Error {}

// Tracks real spend across one run and stops further calls once the cap is passed.
export class Budget {
  constructor(capUsd) { this.cap = capUsd; this.spent = 0; this.calls = []; }
  add(entry) { this.spent += entry.cost; this.calls.push(entry); }
  check() { if (this.spent >= this.cap) throw new BudgetExceeded(`Spent $${this.spent.toFixed(3)} of $${this.cap} cap`); }
  byStep() {
    const out = {};
    for (const c of this.calls) {
      const s = (out[c.step] ||= { calls: 0, inTokens: 0, outTokens: 0, cost: 0, models: {} });
      s.calls++; s.inTokens += c.inTokens; s.outTokens += c.outTokens; s.cost += c.cost;
      s.models[c.model] = (s.models[c.model] || 0) + 1;
    }
    for (const s of Object.values(out)) s.cost = +s.cost.toFixed(4);
    return out;
  }
}

const URL = 'https://openrouter.ai/api/v1/chat/completions';

function estimateCost(model, inT, outT) {
  const price = modelsConfig().prices[model.replace(/:.*$/, '')];
  if (!price) return 0;
  return (inT * price[0] + outT * price[1]) / 1e6;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('Model did not return JSON');
}

/**
 * One chat call. `models` is [primary, ...fallbacks]; OpenRouter tries them in order.
 * With `schema`, the reply is parsed and returned as an object.
 */
export async function chat({ step, models, system, user, schema, maxTokens = 2000, reasoning = false, budget }) {
  budget?.check();
  const body = {
    models,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    usage: { include: true },
  };
  // Reasoning tokens bill as output; keep them off unless a step asks for them.
  // Temperature is left at each model's default: Claude models on OpenRouter reject it.
  body.reasoning = reasoning ? (typeof reasoning === 'object' ? reasoning : { effort: 'medium' }) : { enabled: false };
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: step, strict: true, schema } };
    body.provider = { require_parameters: true };
  }

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.SITE_URL || 'https://github.com/morning-servo',
          'X-Title': 'The Morning Servo',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const msg = data.error?.message || JSON.stringify(data).slice(0, 300);
        // Some models (e.g. GLM) can't turn thinking off; retry them with light, hidden thinking.
        if (/reasoning is mandatory/i.test(msg) && body.reasoning?.enabled === false) {
          log(`  ${step}: ${data.model || models[0]} requires thinking; retrying with light thinking`);
          body.reasoning = { effort: 'low', exclude: true };
          body.max_tokens = maxTokens + 4000;
          attempt--;
          continue;
        }
        throw new Error(`OpenRouter ${res.status}: ${msg}`);
      }

      const model = data.model;
      const inTokens = data.usage?.prompt_tokens || 0;
      const outTokens = data.usage?.completion_tokens || 0;
      const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : estimateCost(model, inTokens, outTokens);
      budget?.add({ step, model, inTokens, outTokens, cost, ms: Date.now() - t0 });

      const text = data.choices?.[0]?.message?.content || '';
      return { model, cost, inTokens, outTokens, ms: Date.now() - t0, text, json: schema ? parseJson(text) : undefined };
    } catch (err) {
      lastErr = err;
      log(`  ${step}: attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

export const stepModels = (name) => modelsConfig().steps[name];
