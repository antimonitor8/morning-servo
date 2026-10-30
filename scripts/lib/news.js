import Parser from 'rss-parser';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { readJson, p, hash, clip, titleTokens, sameStory, mapLimit, log } from './util.js';

const UA = 'Mozilla/5.0 (compatible; MorningServo/1.0; personal news reader)';
const parser = new Parser({ timeout: 20_000, headers: { 'User-Agent': UA } });

/** Pull every source, keep items published inside the window. */
export async function fetchAll(windowHours) {
  const sources = readJson(p('config/sources.json'), []);
  const since = Date.now() - windowHours * 3600_000;
  const report = [];
  const lists = await mapLimit(sources, 6, async (src) => {
    try {
      // Hard stop per feed so one slow site can't stall the whole run.
      const feed = await Promise.race([
        parser.parseURL(src.url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 30s')), 30_000)),
      ]);
      const items = (feed.items || [])
        .map((it) => ({
          id: hash(it.link || it.guid || it.title),
          title: clip(it.title, 200),
          link: it.link,
          source: src.name,
          published: it.isoDate || it.pubDate || null,
          snippet: clip(it.contentSnippet || it.summary || it.content || '', 400),
        }))
        .filter((it) => it.title && it.link)
        // Items without a date are kept; feeds like arXiv list only the current day anyway.
        .filter((it) => !it.published || Date.parse(it.published) >= since)
        .slice(0, src.maxItems || 50);
      report.push({ source: src.name, items: items.length });
      return items;
    } catch (err) {
      report.push({ source: src.name, items: 0, error: err.message.slice(0, 120) });
      return [];
    }
  });
  return { items: lists.flat(), report };
}

/** Merge the same story reported by several outlets; drop stories seen in recent editions. */
export function dedupe(items, seenTitles = [], seenLinks = []) {
  const seenTok = seenTitles.map(titleTokens);
  const links = new Set(seenLinks);
  const clusters = [];
  for (const it of items) {
    if (links.has(it.link)) continue;
    const tok = titleTokens(it.title);
    if (seenTok.some((s) => sameStory(s, tok))) continue;
    const match = clusters.find((c) => sameStory(c.tok, tok));
    if (match) {
      match.also.push({ name: it.source, url: it.link });
      if (it.snippet.length > match.snippet.length) match.snippet = it.snippet;
    } else {
      clusters.push({ ...it, tok, also: [] });
    }
  }
  return clusters.map(({ tok, ...c }) => c);
}

/** Main article text for a story, or '' if the page can't be read. */
export async function fullText(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return '';
    const t0 = Date.now();
    // Parsing is synchronous and can't be timed out, so cap the work up front:
    // very large pages are cut short, and Readability gives up on huge DOMs.
    const html = (await res.text()).slice(0, 1_500_000);
    const { document } = parseHTML(html);
    const article = new Readability(document, { maxElemsToParse: 6000 }).parse();
    const ms = Date.now() - t0;
    if (ms > 3000) log(`  slow page (${(ms / 1000).toFixed(1)}s to parse): ${url}`);
    return clip(article?.textContent || '', 9000);
  } catch (err) {
    log(`  full text failed for ${url}: ${err.message}`);
    return '';
  }
}
