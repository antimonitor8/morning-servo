/* The Morning Servo — renders an edition JSON as swipeable newspaper pages. */
(() => {
  const view = document.getElementById('view');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const fmtDate = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', opts);
  const longDate = (iso) => fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const money = (m) => (m >= 1000 ? `$${(m / 1000).toFixed(1)}B` : `$${Math.round(m)}M`);

  let index = [];
  const editions = new Map();

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }
  async function loadIndex() {
    try { index = await getJson('editions/index.json'); } catch { index = []; }
    return index;
  }
  async function loadEdition(date) {
    if (!editions.has(date)) editions.set(date, await getJson(`editions/${date}.json`));
    return editions.get(date);
  }

  // ---------- Saved items ----------
  const savedKey = 'servo.saved';
  const saved = () => store.get(savedKey, []);
  const isSaved = (id) => saved().some((x) => x.id === id);
  function toggleSaved(item) {
    const list = saved();
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list.splice(i, 1); else list.unshift({ ...item, savedAt: Date.now() });
    store.set(savedKey, list);
    return i < 0;
  }

  // ---------- Edition pages ----------
  function pageList(e) {
    const pages = [{ id: 'A1', kind: 'front' }];
    e.stories.forEach((s, i) => pages.push({ id: `A${i + 2}`, kind: 'story', i }));
    pages.push({ id: 'D1', kind: 'money' }, { id: 'D2', kind: 'briefs' });
    if (e.think) pages.push({ id: 'T1', kind: 'think' });
    return pages;
  }

  const folio = (e, label) => `<div class="folio"><a href="#p=A1" class="home">↩ Front page</a><span>${esc(longDate(e.date))}</span><b>${esc(label)}</b></div>`;

  function front(e, pages) {
    const lead = e.stories[0];
    const below = e.stories.slice(1, 3);
    const count = (kind) => pages.filter((p) => p.kind === kind).length;
    const sections = [];
    e.stories.forEach((s, i) => {
      const last = sections[sections.length - 1];
      if (last && last.kicker === s.kicker) last.n++;
      else sections.push({ kicker: s.kicker, page: `A${i + 2}`, n: 1 });
    });
    const inside = [
      ...sections.map((s) => [s.page, s.kicker, `${s.n} ${s.n === 1 ? 'story' : 'stories'}`]),
      ['D1', 'The Money', `${e.money.rounds.length} rounds`],
      ['D2', 'In Brief', `${e.briefs.length} headlines`],
      ...(e.think ? [['T1', 'Think', e.sunday ? 'Sunday edition' : '4 min']] : []),
    ];
    return `
      <div class="mast"><div class="name">${e.sunday ? esc(e.paper.replace('Morning', 'Sunday')) : esc(e.paper)}</div></div>
      <div class="dateline"><span>${esc(longDate(e.date))}</span><span>No. ${e.number}</span><span>${e.readMinutes} min read</span></div>
      <div class="ears">
        <div>Today: <b>${e.stories.length}</b> stories, <b>${e.briefs.length}</b> briefs${e.think ? ', and the Think page' : ''}</div>
        <div>${e.money.rounds.length ? `Funding today: <b>${money(e.money.totalUsdM)}</b> across <b>${e.money.rounds.length}</b> deals` : 'No funding rounds reported today'}</div>
      </div>
      ${lead ? `<a class="lead lead-link" href="#p=A2">
        <span class="kicker">${esc(lead.kicker)}</span>
        <h1 class="hl xl">${esc(lead.headline)}</h1>
        <p class="deck">${esc(lead.deck)}</p>
        <p class="body drop">${esc(lead.body[0])}</p>
        <div class="box"><span class="kicker">Why it matters</span>${esc(lead.why)}</div>
      </a>` : '<p class="empty-note">No top stories today.</p>'}
      ${below.length ? `<div class="cols">${below.map((s, j) => `<a href="#p=A${j + 3}"><span class="kicker">${esc(s.kicker)}</span><h2 class="hl m">${esc(s.headline)}</h2><p>${esc(s.deck)}</p></a>`).join('')}</div>` : ''}
      <nav class="inside"><h4 class="sec">Inside today</h4><ul>
        ${inside.map(([pg, name, n]) => `<li><a href="#p=${pg}"><span class="pg">${pg}</span><span>${esc(name)}</span><span class="n">${esc(n)}</span></a></li>`).join('')}
      </ul></nav>`;
  }

  function story(e, i) {
    const s = e.stories[i];
    const next = e.stories[i + 1];
    const id = `${e.date}:${s.id}`;
    const tag = (k, v) => `<span class="tag"><i>${k}</i> ${esc(v)}</span>`;
    return `
      <span class="kicker">${esc(s.kicker)} · Story ${i + 1} of ${e.stories.length}</span>
      <h1 class="hl l">${esc(s.headline)}</h1>
      <p class="deck">${esc(s.deck)}</p>
      <div class="meta"><span>${s.sources.length > 1 ? `Reported by ${s.sources.length} outlets` : esc(s.sources[0]?.name)}</span><span>${Math.max(1, Math.round([...s.body, s.why, s.hard].join(' ').split(/\s+/).length / 230))} min</span></div>
      ${s.body.map((b, j) => `<p class="body${j === 0 ? ' drop' : ''}">${esc(b)}</p>`).join('')}
      <div class="box"><span class="kicker">Why it matters</span>${esc(s.why)}</div>
      <div class="box"><span class="kicker">What's still hard</span>${esc(s.hard)}</div>
      <div class="tags">${(s.tags.industry || []).map((v) => tag('Industry', v)).join('')}${(s.tags.task || []).map((v) => tag('Task', v)).join('')}</div>
      <div class="sources"><span class="sec">Sources</span>${s.sources.map((src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)} ↗</a>`).join('')}</div>
      <div class="actions"><button class="btn${isSaved(id) ? ' on' : ''}" data-save="${esc(id)}" data-kind="story" data-i="${i}">${isSaved(id) ? '★ Saved' : '☆ Save'}</button></div>
      ${next ? `<a class="next" href="#p=A${i + 3}">Next, story ${i + 2} of ${e.stories.length}<b>${esc(next.headline)} →</b></a>` : `<a class="next" href="#p=D1">Next<b>The Money →</b></a>`}`;
  }

  function moneyPage(e) {
    const r = e.money.rounds;
    return `
      <div class="pagehead"><span class="t">The Money</span><span class="p">Page D1</span></div>
      ${r.length ? `<div class="tbl-wrap"><table>
        <thead><tr><th>Company</th><th>Round</th><th class="amt">Raised</th></tr></thead>
        <tbody>${r.map((x) => `<tr>
          <td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.company)}</a>${x.india ? '<span class="in">IN</span>' : ''}<small>${esc(x.what)}</small></td>
          <td>${esc(x.round)}<small>${esc(x.lead)}</small></td>
          <td class="amt">${esc(x.amount_text)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="tally">Disclosed total: <b>${money(e.money.totalUsdM)}</b> across ${r.length} deals · Tap a company for the source</div>`
        : '<p class="empty-note">No funding rounds were reported in the last day.</p>'}
      <a class="next" href="#p=D2">Next<b>In Brief →</b></a>`;
  }

  function briefsPage(e) {
    return `
      <div class="pagehead"><span class="t">In Brief</span><span class="p">Page D2</span></div>
      <ul class="briefs">${e.briefs.map((b) => `<li><span class="k">${esc(b.kicker)} · ${esc(b.source)}</span>${esc(b.headline)}<a class="src" href="${esc(b.url)}" target="_blank" rel="noopener">source ↗</a></li>`).join('')}</ul>
      ${e.think ? '<a class="next" href="#p=T1">Last page<b>Think →</b></a>' : doneBlock(e)}`;
  }

  function refLink(e, r) {
    const page = r.kind === 'story' ? `A${r.n + 1}` : 'D2';
    return `<a href="#p=${page}"><i>${r.kind === 'story' ? 'Story' : 'Brief'} ${r.n}</i>${esc(r.label)}</a>`;
  }

  function thinkPage(e) {
    const t = e.think;
    const c = t.collision;
    const k = t.contrarian;
    const cid = `${e.date}:collision`;
    const savedIdeas = new Set(saved().filter((x) => x.kind === 'idea').map((x) => x.headline));
    const on = e.stories[(k.story_n || 1) - 1];
    return `
      <div class="think-mast"><div class="w">THINK</div><div class="s">Page T1 · ${esc(e.weekday)}${e.sunday ? ' · Sunday edition' : ''}</div></div>
      <section class="block">
        <span class="kicker">The Collision</span>
        <div class="mix">${refLink(e, c.a)}<span class="x">×</span>${refLink(e, c.b)}</div>
        <h2 class="hl m">${esc(c.headline)}</h2>
        <p class="body">${esc(c.body)}</p>
        <dl class="grid"><dt>Who'd pay</dt><dd>${esc(c.who_pays)}</dd><dt>Data it needs</dt><dd>${esc(c.data_needed)}</dd><dt>Why it might fail</dt><dd>${esc(c.why_fail)}</dd></dl>
        <div class="actions"><button class="btn${isSaved(cid) ? ' on' : ''}" data-save="${esc(cid)}" data-kind="idea">${isSaved(cid) ? '★ Worth exploring' : '☆ Worth exploring'}</button></div>
      </section>
      <section class="block">
        <span class="kicker">The Contrarian Take</span>
        <h2 class="hl m">On ${on ? `story ${k.story_n}: ${esc(on.headline)}` : "today's lead"}</h2>
        <div class="consensus"><b>The consensus</b>${esc(k.consensus)}</div>
        <h4 class="sec">The case against</h4>
        <ol class="against">${k.against.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
        <dl class="grid"><dt>Who bets otherwise</dt><dd>${esc(k.bets_otherwise)}</dd><dt>What would settle it</dt><dd>${esc(k.settle_it)}</dd></dl>
      </section>
      ${t.outside ? `<section class="block">
        <span class="kicker">Outside the Bubble · ${esc(t.outside.field)}</span>
        <h2 class="hl l">${esc(t.outside.headline)}</h2>
        <p class="body drop">${esc(t.outside.body)}</p>
        <div class="pull">${esc(t.outside.pull)}</div>
        <dl class="grid"><dt>Why it helps</dt><dd>${esc(t.outside.why_helps)}</dd><dt>Who might try it</dt><dd>${esc(t.outside.who_might)}</dd></dl>
      </section>` : ''}
      ${t.wildcard ? `<section class="block">
        <span class="kicker">Wild Card</span>
        <h2 class="hl l">${esc(t.wildcard.headline)}</h2>
        <dl class="grid"><dt>What changed</dt><dd>${esc(t.wildcard.changed)}</dd><dt>Who won</dt><dd>${esc(t.wildcard.won)}</dd><dt>What broke</dt><dd>${esc(t.wildcard.broke)}</dd><dt>Your move</dt><dd>${esc(t.wildcard.your_move)}</dd></dl>
      </section>` : ''}
      ${t.week?.length ? `<section class="block">
        <span class="kicker">Best Collisions of the Week</span>
        <ul class="week">${t.week.map((w) => `<li class="${savedIdeas.has(w.headline) ? 'saved' : ''}"><span>${esc((w.weekday || '').slice(0, 3))}${savedIdeas.has(w.headline) ? ' ★' : ''}</span>${esc(w.headline)}</li>`).join('')}</ul>
      </section>` : ''}
      ${doneBlock(e)}`;
  }

  const doneBlock = (e) => `<div class="done"><b>You're done for today.</b><span>Tomorrow's edition arrives at 8:00.</span><span>This edition cost $${(e.cost?.usd ?? 0).toFixed(2)} to make.</span></div>`;

  function renderEdition(e) {
    const pages = pageList(e);
    const body = (p) => {
      if (p.kind === 'front') return front(e, pages);
      if (p.kind === 'story') return folio(e, p.id) + story(e, p.i);
      if (p.kind === 'money') return folio(e, p.id) + moneyPage(e);
      if (p.kind === 'briefs') return folio(e, p.id) + briefsPage(e);
      return folio(e, p.id) + thinkPage(e);
    };
    view.innerHTML = `<div class="pages" id="pages">${pages.map((p) => `<section class="page" id="page-${p.id}" aria-label="Page ${p.id}"><div class="page-inner">${body(p)}</div></section>`).join('')}</div>`;

    const strip = document.getElementById('pages');
    const posKey = `servo.pos.${e.date}`;
    const start = store.get(posKey, 0);
    strip.style.scrollBehavior = 'auto';
    strip.scrollLeft = start * strip.clientWidth;
    strip.style.scrollBehavior = '';
    let t;
    strip.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => store.set(posKey, Math.round(strip.scrollLeft / strip.clientWidth)), 150);
    }, { passive: true });

    view.onclick = (ev) => {
      const a = ev.target.closest('a[href^="#p="]');
      if (a) {
        ev.preventDefault();
        const target = document.getElementById(`page-${a.getAttribute('href').slice(3)}`);
        if (target) { target.scrollTop = 0; strip.scrollTo({ left: target.offsetLeft }); }
        return;
      }
      const b = ev.target.closest('[data-save]');
      if (!b) return;
      const id = b.dataset.save;
      let item;
      if (b.dataset.kind === 'story') {
        const s = e.stories[+b.dataset.i];
        item = { id, kind: 'story', date: e.date, headline: s.headline, deck: s.deck, url: s.sources[0]?.url };
      } else {
        item = { id, kind: 'idea', date: e.date, headline: e.think.collision.headline, deck: e.think.collision.body };
      }
      const now = toggleSaved(item);
      b.classList.toggle('on', now);
      b.textContent = b.dataset.kind === 'story' ? (now ? '★ Saved' : '☆ Save') : (now ? '★ Worth exploring' : '☆ Worth exploring');
    };
  }

  // ---------- Other views ----------
  function plain(html) { view.innerHTML = `<div class="plain">${html}</div>`; view.onclick = null; }

  function renderEmpty() {
    plain(`<div class="mast"><div class="name">The Morning Servo</div></div>
      <p>The first edition hasn't been printed yet. It arrives at 8:00 IST.</p>
      <p>While you wait, open <a href="#/settings">Settings</a> to turn on the morning notification.</p>`);
  }

  function renderArchive() {
    const month = new Date().toISOString().slice(0, 7);
    const spent = index.filter((x) => x.date.startsWith(month)).reduce((n, x) => n + (x.costUsd || 0), 0);
    plain(`<div class="pagehead"><span class="t">Archive</span><span class="p">${index.length} editions</span></div>
      ${index.length ? `<ul class="list">${index.map((x) => `<li><a href="#/e/${x.date}"><span class="d">${esc(longDate(x.date))} · No. ${x.number} · ${x.readMinutes} min</span><span class="h">${esc(x.lead)}</span></a></li>`).join('')}</ul>
      <p class="status-line">Spent this month: $${spent.toFixed(2)}</p>` : '<p class="empty-note">No editions yet.</p>'}`);
  }

  function renderSaved() {
    const list = saved();
    const group = (kind, title) => {
      const items = list.filter((x) => x.kind === kind);
      return `<h4 class="sec" style="margin-top:14px">${title}</h4>${items.length ? `<ul class="list">${items.map((x) => `<li><div class="row"><a href="${x.url ? esc(x.url) : `#/e/${x.date}`}"${x.url ? ' target="_blank" rel="noopener"' : ''}><span class="d">${esc(longDate(x.date))}</span><span class="h">${esc(x.headline)}</span></a><button class="x-btn" data-remove="${esc(x.id)}">Remove</button></div></li>`).join('')}</ul>` : `<p class="empty-note">${kind === 'story' ? 'Tap ☆ Save on any story to keep it here.' : 'Tap ☆ Worth exploring on a Collision to keep it here.'}</p>`}`;
    };
    plain(`<div class="pagehead"><span class="t">Saved</span><span class="p">${list.length} items</span></div>${group('idea', 'Ideas worth exploring')}${group('story', 'Stories')}`);
    view.onclick = (ev) => {
      const b = ev.target.closest('[data-remove]');
      if (!b) return;
      store.set(savedKey, saved().filter((x) => x.id !== b.dataset.remove));
      renderSaved();
    };
  }

  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  async function renderSettings() {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready.catch(() => null) : null;
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription().catch(() => null) : null;
    const latest = index[0];
    plain(`<div class="pagehead"><span class="t">Settings</span><span class="p">The Morning Servo</span></div>
      <div class="settings">
        <section>
          <h3>Morning notification</h3>
          ${!standalone() ? `<p>To get the 8:00 notification on iPhone, add the paper to your Home Screen first:</p>
            <ol><li>Open this page in Safari.</li><li>Tap the Share button.</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open the paper from the new Home Screen icon and come back to Settings.</li></ol>`
            : `<p class="status-line${sub ? ' ok' : ''}">${sub ? 'Notifications are on.' : 'Notifications are off.'}</p>
            <button class="btn primary" id="enable">${sub ? 'Show my device code again' : 'Turn on 8:00 notifications'}</button>`}
          <div id="subout"></div>
        </section>
        <section>
          <h3>Latest edition</h3>
          ${latest ? `<p class="status-line">No. ${latest.number}, ${esc(longDate(latest.date))}. ${latest.stories} stories. Cost $${(latest.costUsd || 0).toFixed(2)}.</p>` : '<p class="status-line">No editions yet.</p>'}
        </section>
      </div>`);
    const btn = document.getElementById('enable');
    if (!btn) return;
    btn.onclick = async () => {
      const out = document.getElementById('subout');
      try {
        if (!reg) throw new Error('Offline support is not running. Reload the app and try again.');
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('Notifications were not allowed. Turn them on in iPhone Settings → Notifications → Servo.');
        const s = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(window.SERVO_CONFIG.vapidPublicKey) });
        const code = JSON.stringify(s);
        out.innerHTML = `<p>Notifications are allowed. Last step: copy this device code and send it to Claude (or save it as the <b>PUSH_SUBSCRIPTION</b> secret on GitHub).</p>
          <textarea id="code" readonly>${esc(code)}</textarea><button class="btn" id="copy">Copy code</button> <span class="status-line" id="copied"></span>`;
        document.getElementById('copy').onclick = async () => {
          try { await navigator.clipboard.writeText(code); document.getElementById('copied').textContent = 'Copied'; } catch { const ta = document.getElementById('code'); ta.focus(); ta.select(); }
        };
      } catch (err) {
        out.innerHTML = `<p class="status-line">${esc(err.message)}</p>`;
      }
    };
  }

  // ---------- Router ----------
  async function route() {
    const h = location.hash;
    const tab = h.startsWith('#/archive') ? 'archive' : h.startsWith('#/saved') ? 'saved' : h.startsWith('#/settings') ? 'settings' : 'today';
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    if (!index.length) await loadIndex();
    if (tab === 'archive') return renderArchive();
    if (tab === 'saved') return renderSaved();
    if (tab === 'settings') return renderSettings();
    const date = h.startsWith('#/e/') ? h.slice(4) : index[0]?.date;
    if (!date) return renderEmpty();
    try { renderEdition(await loadEdition(date)); } catch { plain('<p class="empty-note">This edition could not be loaded. Check your connection and try again.</p>'); }
  }

  // Tapping Today while reading today's paper goes back to the front page.
  document.querySelector('.tabbar a[data-tab="today"]').addEventListener('click', (ev) => {
    const strip = document.getElementById('pages');
    const onToday = location.hash === '' || location.hash === '#/';
    if (!strip || !onToday) return;
    ev.preventDefault();
    const front = document.getElementById('page-A1');
    front.scrollTop = 0;
    strip.scrollTo({ left: 0 });
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', async () => {
    // Coming back in the morning: pick up a newer edition if one has been printed.
    if (document.visibilityState !== 'visible') return;
    const before = index[0]?.date;
    await loadIndex();
    if (index[0]?.date !== before && (location.hash === '' || location.hash === '#/')) route();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  route();
})();
