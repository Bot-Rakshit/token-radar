/* Token Radar page. It recomputes the whole radar in the browser from ../data.js (the sealed snapshot,
 * written by main.ts) with 1-model.js and 2-farm.js, then checks every value against board.json's
 * (checkParity). State lives in the URL hash, so every view is a link: #view=ranked&cat=RWA&p=<slug>.
 */
(function () {
  'use strict';
  const M = window.RadarModel;
  const radar = M.buildRadar(window.RADAR_SNAPSHOT);
  const parity = M.checkParity(radar, window.BOARD_VALUES);
  const cal = radar.cal, S = radar.summary, usd = M.usd;
  const rowsBySlug = new Map(radar.rows.map((r) => [r.slug, r]));
  const root = document.getElementById('app');

  // ---------- formatting ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x === null ? '<span class="dim">n/a</span>' : `<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}%</span>`);
  const times = (x, d = 3) => '×' + x.toFixed(d);
  const ageText = (d) => (d === null ? 'not dated' : d < 365 ? `${d}d` : `${(d / 365).toFixed(1)}y`);
  const tierTag = (t) => `<span class="tag ${t}">${t === 'watchlist' ? 'WL' : 'EARLY'}</span>`;

  // ---------- state in the hash ----------
  const DEFAULTS = { view: 'ranked', q: '', cat: '', chain: '', tier: 'all', sort: 'implied', dir: 'desc', p: '' };
  let state = readHash();
  function readHash() {
    const s = { ...DEFAULTS };
    for (const part of location.hash.slice(1).split('&')) {
      const [k, v] = part.split('=');
      if (k in s && v !== undefined) s[k] = decodeURIComponent(v);
    }
    return s;
  }
  function setState(patch) {
    const next = { ...state, ...patch };
    location.hash = Object.keys(next).filter((k) => next[k] !== DEFAULTS[k]).map((k) => `${k}=${encodeURIComponent(next[k])}`).join('&');
  }
  window.addEventListener('hashchange', () => { state = readHash(); render(); });

  // ---------- the board: filter, then sort ----------
  const SORTS = {
    rank: (r) => -r.rank, name: (r) => r.name.toLowerCase(), tvl: (r) => r.tvl, change7d: (r) => (r.change7d === null ? -1e9 : r.change7d),
    days: (r) => (r.days === null ? -1 : r.days), multiple: (r) => r.effective, implied: (r) => r.implied, cap: (r) => r.plan.share / r.plan.cap,
  };
  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    const rows = radar.rows.filter((r) => (!state.cat || r.category === state.cat) && (!state.chain || r.chains.includes(state.chain)) &&
      (state.tier === 'all' || r.tier === state.tier) && (!q || `${r.name} ${r.category} ${r.chains.join(' ')}`.toLowerCase().includes(q)));
    const key = SORTS[state.sort] || SORTS.implied, sign = state.dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sign || a.rank - b.rank; });
  }

  // ---------- header, ledger and model strip ----------
  function renderTop() {
    const ok = parity.match === parity.total;
    return `<header class="top"><div class="brand"><svg viewBox="0 0 20 20" class="mark" aria-hidden="true"><circle cx="10" cy="10" r="8.5"/><circle cx="10" cy="10" r="4.5"/><path d="M10 10 L17 4"/></svg><b>Token Radar</b><span class="dim">pre-token protocols ranked by implied value</span></div>
      <div class="meta"><span>Snapshot ${esc(radar.as_of)} · DefiLlama · ${S.protocols} protocols</span><span>model ${esc(M.MODEL_VERSION)}</span>
      <span class="parity ${ok ? 'ok' : 'bad'}" title="Every ranked row recomputed in this page from the snapshot and compared with board.json">${ok ? '✓' : '✗'} ${parity.match}/${parity.total} values recomputed here = board.json</span></div></header>`;
  }

  function renderLedger() {
    const tab = (view, n, label, note) => `<button class="led ${state.view === view ? 'on' : ''}" data-view="${view}"><b>${n}</b><span>${label}</span><i>${note}</i></button>`;
    return `<nav class="ledger" aria-label="Where every protocol went"><div class="eq"><b>${S.protocols}</b><span>protocols</span><i>in the snapshot</i></div><div class="op">=</div>
      ${tab('ranked', S.watchlist + S.early, 'ranked, no token', `${S.watchlist} watchlist + ${S.early} early`)}<div class="op">+</div>
      ${tab('trades', S.trades, 'token trades', 'market cap: priced by the market')}<div class="op">+</div>
      ${tab('recorded', S.recorded, 'token recorded', 'ticker or id, no cap')}<div class="op">+</div>
      ${tab('aside', S.set_aside, 'set aside', 'wrapped, custodial, sub-product')}<div class="op">·</div>
      ${tab('peers', S.peers, 'peers calibrate', 'traded tokens priced per $ TVL')}</nav>`;
  }

  function renderModel() {
    const b = radar.backtest, fams = Object.keys(cal.famMu), max = Math.max(...fams.map((f) => Math.exp(cal.famMu[f])));
    const bars = fams.map((f, i) => {
      const m = Math.exp(cal.famMu[f]), w = 150 * m / max, y = i * 15;
      return `<text x="0" y="${y + 10}">${esc(f)}</text><rect x="104" y="${y + 2}" width="${w.toFixed(1)}" height="10"/><text x="${(108 + w).toFixed(1)}" y="${y + 10}" class="v">${times(m, 2)} <tspan class="dim">n=${(cal.fam[f] || []).length}</tspan></text>`;
    }).join('');
    return `<section class="model"><div class="formula"><h3>How a row is valued</h3>
      <p class="eq">implied = TVL × <em>peer multiple</em> × <em>size</em> × <em>growth</em> × <em>no-token age</em></p>
      <ul><li><em>peer multiple</em>: market cap ÷ TVL of ${S.peers} traded peers, by category, shrunk to its family (weight n/(n+${cal.K}))</li>
      <li><em>size</em> (TVL ÷ ${usd(cal.floor)})<sup>−${cal.gamma.toFixed(3)}</sup>: half the slope fitted on the peers (${cal.slope.toFixed(2)})</li>
      <li><em>growth</em> (1 + 7d)<sup>${M.CONFIG.growth_elasticity}</sup>, 7d clamped −50…+100% · <em>no-token age</em> ×0.85 new → ×1.15 at 3y</li></ul></div>
      <div class="fams"><h3>Peer multiple at ${usd(cal.floor)} TVL, by family</h3><svg viewBox="0 0 320 92" class="bars">${bars}</svg></div>
      <div class="test"><h3>Out-of-sample test</h3><p>Each of ${b.n} traded peers left out, model refit, its market cap predicted. Median miss:</p>
      <table class="mini"><tr><td>this model</td><td class="num"><b>${times(b.model.median, 1)}</b></td><td class="num">${Math.round(b.model.within3 * 100)}% within 3×</td></tr>
      <tr><td>category median</td><td class="num">${times(b.category.median, 1)}</td><td class="num">${Math.round(b.category.within3 * 100)}%</td></tr>
      <tr><td>flat ${M.CONFIG.flat_multiple}× TVL</td><td class="num">${times(b.flat.median, 1)}</td><td class="num">${Math.round(b.flat.within3 * 100)}%</td></tr></table></div></section>`;
  }

  // ---------- controls and the ranked table ----------
  function renderControls(rows) {
    const cats = [...new Set(radar.rows.map((r) => r.category))].sort();
    const chainCount = {};
    for (const r of radar.rows) for (const c of r.chains) chainCount[c] = (chainCount[c] || 0) + 1;
    const chains = Object.keys(chainCount).sort((a, b) => chainCount[b] - chainCount[a] || (a < b ? -1 : 1));
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const seg = (v, label) => `<button class="${state.tier === v ? 'on' : ''}" data-tier="${v}">${label}</button>`;
    const active = state.cat || state.chain || state.tier !== 'all' || state.q;
    return `<div class="controls"><label>Search<input id="q" type="search" value="${esc(state.q)}" placeholder="name, category or chain"></label>
      <label>Category<select id="cat">${opt('', `All categories (${cats.length})`, state.cat)}${cats.map((c) => opt(c, c, state.cat)).join('')}</select></label>
      <label>Chain<select id="chain">${opt('', 'All chains', state.chain)}${chains.map((c) => opt(c, `${c} (${chainCount[c]})`, state.chain)).join('')}</select></label>
      <div class="seg" role="group" aria-label="Tier">${seg('all', 'All')}${seg('watchlist', 'Watchlist')}${seg('early', 'Early')}</div>
      <div class="count"><b>${rows.length}</b> of ${radar.rows.length} rows${active ? ' <button class="link" data-clear="1">clear filters</button>' : ''}</div></div>`;
  }

  function renderBoard(rows) {
    const maxV = radar.rows[0].high;
    const scale = (v) => (Math.log10(v) - 5.5) / (Math.log10(maxV) - 5.5) * 100;
    const th = (key, label, cls = '') => {
      const on = state.sort === key, arrow = on ? (state.dir === 'asc' ? '▲' : '▼') : '';
      return `<th class="${cls} ${on ? 'sorted' : ''}" data-sort="${key}" aria-sort="${on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}<span class="ar">${arrow}</span></th>`;
    };
    const body = rows.map((r) => {
      const lo = scale(r.low), hi = scale(r.high), mid = scale(r.implied), p = r.plan;
      return `<tr data-slug="${esc(r.slug)}" class="${state.p === r.slug ? 'sel' : ''}"><td class="num rank">${r.rank}</td>
        <td><div class="nm">${esc(r.name)} ${tierTag(r.tier)}${r.caution ? '<span class="tag warn" title="' + esc(r.caution) + '">!</span>' : ''}</div><div class="sub">${esc(r.category)} · ${esc(r.chains[0] || '')}${r.chains.length > 1 ? ` +${r.chains.length - 1}` : ''}</div></td>
        <td class="num">${usd(r.tvl)}</td><td class="num">${pct(r.change7d)}</td><td class="num">${ageText(r.days)}</td><td class="num">${times(r.effective)}</td>
        <td class="val"><div class="range"><i style="left:${lo.toFixed(1)}%;width:${(hi - lo).toFixed(1)}%"></i><b style="left:${mid.toFixed(1)}%"></b></div><span class="num big">${usd(r.implied)}</span></td>
        <td class="farm"><b>${usd(p.cap)}</b> on ${esc(p.venue)} · ${usd(p.fees)} fees · ${p.hold}d<div class="sub">${p.steps.length} steps · share ≈ ${usd(p.share)}</div></td></tr>`;
    }).join('');
    return `<table class="board"><thead><tr>${th('rank', '#', 'num')}${th('name', 'Protocol')}${th('tvl', 'TVL', 'num')}${th('change7d', '7d', 'num')}${th('days', 'No token', 'num')}${th('multiple', 'Value ÷ TVL', 'num')}${th('implied', 'Implied value · low–high', 'val')}${th('cap', 'Farm plan · position, fees, hold', 'farm')}</tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="empty">No row matches these filters.</td></tr>'}</tbody></table>`;
  }

  /** With a category picked: the category's totals and the traded peers that price it. */
  function renderCategoryPanel(rows) {
    if (!state.cat) return '';
    const pm = M.peerMultiple(cal, state.cat), wl = rows.filter((r) => r.tier === 'watchlist').length;
    const peerRows = pm.peers.slice().sort((a, b) => b.tvl - a.tvl).map((q) => `<tr><td>${esc(q.name)}</td><td class="num">${usd(q.tvl)}</td><td class="num">${usd(q.mcap)}</td><td class="num">${times(q.raw, 2)}</td><td class="num">${times(Math.exp(q.z), 2)}</td></tr>`).join('');
    return `<aside class="catpanel"><h3>${esc(state.cat)} at a glance</h3>
      <dl><dt>Ranked here</dt><dd>${rows.length} (${wl} watchlist · ${rows.length - wl} early)</dd><dt>TVL</dt><dd>${usd(rows.reduce((s, r) => s + r.tvl, 0))}</dd>
      <dt>Implied value</dt><dd>${usd(rows.reduce((s, r) => s + r.implied, 0))}</dd><dt>Peer multiple</dt><dd>${times(pm.multiple)} at ${usd(cal.floor)}</dd>
      <dt>Credibility</dt><dd>${Math.round(pm.weight * 100)}% own peers · ${100 - Math.round(pm.weight * 100)}% ${esc(pm.family)}</dd></dl>
      <h4>${pm.peers.length} traded ${esc(state.cat)} tokens, kept off the board</h4>${pm.peers.length ? `<table class="mini peers"><tr><th>Peer</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">÷TVL</th><th class="num">at ${usd(cal.floor)}</th></tr>${peerRows}</table>` : `<p class="dim">None trade, so the ${esc(pm.family)} family's ${times(pm.familyMultiple)} prices it.</p>`}</aside>`;
  }

  // ---------- the other ledger views ----------
  function renderList() {
    if (state.view === 'peers') {
      const rows = cal.pts.slice().sort((a, b) => b.mcap - a.mcap);
      return `<p class="lede">${rows.length} protocols whose token trades and whose market cap belongs to their own TVL. Their multiple, restated at ${usd(cal.floor)} of TVL and clipped to ${times(cal.winsor[0])}–${times(cal.winsor[1], 2)}, prices every ranked row. Never ranked.</p>
        <table class="board list"><thead><tr><th>Peer</th><th>Category · family</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Mcap ÷ TVL</th><th class="num">At ${usd(cal.floor)}</th></tr></thead><tbody>${rows.map((q) => `<tr><td>${esc(q.name)}</td><td>${esc(q.category)} · ${esc(q.family)}</td><td class="num">${usd(q.tvl)}</td><td class="num">${usd(q.mcap)}</td><td class="num">${times(q.raw, 3)}</td><td class="num">${times(Math.exp(q.z), 3)}</td></tr>`).join('')}</tbody></table>`;
    }
    const entries = radar.ledger.filter((e) => e.group === state.view).sort((a, b) => b.p.tvl_usd - a.p.tvl_usd);
    const lede = { trades: 'Their token already trades: the market prices them, so the radar does not. The ones whose cap belongs to their own TVL are the peers.', recorded: 'DefiLlama records a ticker or CoinGecko id but no market cap: a token exists, so they are not pre-token.', aside: 'No token recorded, but not a launch of their own: custodial, wrapped or versioned products, or product lines of a parent.' }[state.view];
    return `<p class="lede">${lede}</p><table class="board list"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th>Why it is not ranked</th></tr></thead><tbody>${entries.map((e) => `<tr><td>${esc(e.p.name)}${e.p.symbol ? ` <span class="dim">${esc(e.p.symbol)}</span>` : ''}</td><td>${esc(e.p.category)}</td><td class="num">${usd(e.p.tvl_usd)}</td><td class="num">${e.p.mcap_usd ? usd(e.p.mcap_usd) : '<span class="dim">—</span>'}</td><td class="why">${esc(e.reason)}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---------- the detail view ----------
  /** Peer multiples on a log axis: the family's peers, the category's own, and where the row's multiple lands. */
  function renderPeerPlot(r) {
    const W = 440, lo = Math.log(cal.winsor[0]), hi = Math.log(cal.winsor[1]);
    const x = (m) => 10 + (Math.log(m) - lo) / (hi - lo) * (W - 20);
    const fam = cal.fam[r.pm.family] || [];
    const dots = fam.map((q, i) => `<circle cx="${x(Math.exp(q.z)).toFixed(1)}" cy="${q.category === r.category ? 30 : 46 + (i % 3) * 5}" r="${q.category === r.category ? 4.5 : 3}" class="${q.category === r.category ? 'own' : ''}"><title>${esc(q.name)} ${times(Math.exp(q.z), 2)}</title></circle>`).join('');
    const mark = (m, cls, label, y) => `<line x1="${x(m).toFixed(1)}" x2="${x(m).toFixed(1)}" y1="14" y2="66" class="${cls}"/><text x="${x(m).toFixed(1)}" y="${y}" class="${cls}" text-anchor="middle">${label}</text>`;
    const labels = fam.filter((q) => q.category === r.category).slice(0, 3).map((q) => `<text x="${x(Math.exp(q.z)).toFixed(1)}" y="24" text-anchor="middle" class="own">${esc(q.name)}</text>`).join('');
    const ticks = [0.01, 0.1, 1].map((t) => `<text x="${x(t).toFixed(1)}" y="80" text-anchor="middle" class="dim">${t}×</text>`).join('');
    return `<svg viewBox="0 0 ${W} 84" class="plot">${ticks}${dots}${labels}${mark(r.pm.familyMultiple, 'famline', `${esc(r.pm.family)} ${times(r.pm.familyMultiple, 2)}`, 10)}${mark(r.pm.multiple, 'useline', `used ${times(r.pm.multiple, 3)}`, 76)}</svg>`;
  }

  /** The traded peers closest in size from the row's family: the market's own prices for a protocol like this one. */
  function renderNearestPeers(r) {
    const near = (cal.fam[r.pm.family] || []).slice().sort((a, b) => Math.abs(Math.log(a.tvl / r.tvl)) - Math.abs(Math.log(b.tvl / r.tvl))).slice(0, 5);
    return `<h4>Closest ${esc(r.pm.family)} tokens by TVL, as the market prices them</h4><table class="mini"><tr><th>Peer</th><th>Category</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">÷TVL</th></tr>${near.map((q) => `<tr><td>${esc(q.name)}</td><td>${esc(q.category)}</td><td class="num">${usd(q.tvl)}</td><td class="num">${usd(q.mcap)}</td><td class="num">${times(q.raw, 3)}</td></tr>`).join('')}</table>`;
  }

  function renderDetail(r) {
    const pm = r.pm, p = r.plan, own = pm.peers.length;
    const line = (label, how, value) => `<tr><td>${label}</td><td class="how">${how}</td><td class="num">${value}</td></tr>`;
    const steps = p.steps.map((s, i) => `<li><span class="n">${i + 1}</span><p>${esc(s.do)}</p><span class="cost">${esc(s.cost)}</span><span class="time">${esc(s.time)}</span></li>`).join('');
    return `<div class="scrim" data-close="1"></div><article class="detail" aria-label="${esc(r.name)}">
      <header><div><div class="dim">Rank ${r.rank} of ${radar.rows.length} · ${tierTag(r.tier)} · ${esc(r.category)} (${esc(pm.family)})</div><h2>${esc(r.name)}</h2>
      <div class="dim chains">${r.chains.length} chain${r.chains.length > 1 ? 's' : ''}: ${esc(r.chains.join(', '))}</div>${r.caution ? `<div class="caution">! ${esc(r.caution)}</div>` : ''}</div>
      <div class="headline"><span class="dim">Implied value</span><b>${usd(r.implied)}</b><span class="dim">low ${usd(r.low)} · high ${usd(r.high)}</span></div><button class="close" data-close="1" aria-label="Close">×</button></header>
      <div class="cols"><section><h3>The working</h3><table class="waterfall">
      ${line('TVL', `${esc(r.chains[0] || '')} and ${r.chains.length - 1} more`, usd(r.tvl))}
      ${line('× peer multiple', own ? `${own} traded ${esc(r.category)} peer${own > 1 ? 's' : ''} ${times(pm.ownMultiple, 2)} at ${Math.round(pm.weight * 100)}%, ${esc(pm.family)} ${times(pm.familyMultiple, 2)} at ${100 - Math.round(pm.weight * 100)}%` : `no traded ${esc(r.category)} peer: ${esc(pm.family)} family, ${(cal.fam[pm.family] || []).length} peers`, times(pm.multiple))}
      ${line('× size', `(${usd(r.tvl)} ÷ ${usd(cal.floor)})<sup>−${cal.gamma.toFixed(3)}</sup>`, times(r.size))}
      ${line('× growth', r.change7d === null ? '7d change not reported' : `7d ${pct(r.change7d)}${Math.abs(r.change7d) > 50 ? ' (clamped)' : ''}, ^${M.CONFIG.growth_elasticity}`, times(r.growth))}
      ${line('× no-token age', r.days === null ? 'listing date not recorded: neutral' : `${r.days} days tracked with no token (${esc(r.listed)})`, times(r.age))}
      <tr class="total"><td>= value ÷ TVL</td><td class="how">${usd(r.tvl)} × ${times(r.effective, 4)}</td><td class="num">${usd(r.implied)}</td></tr></table>
      <h4>Where the multiple comes from: ${(cal.fam[pm.family] || []).length} ${esc(pm.family)} peers at ${usd(cal.floor)} TVL ${own ? '(large dots: ' + esc(r.category) + ')' : ''}</h4>${renderPeerPlot(r)}
      <p class="note">Low and high use the ${pm.bandPool === 'category' ? esc(r.category) : esc(pm.bandPool === 'family' ? pm.family + ' family' : 'all-peer')} quartile multiples (${pm.bandN} peers): ×${pm.lowFactor.toFixed(2)} and ×${pm.highFactor.toFixed(2)} of the value. The page computed ${usd(r.implied)}; board.json says ${usd(window.BOARD_VALUES[r.slug])}.</p>
      ${renderNearestPeers(r)}</section>
      <section><h3>Farm plan <span class="dim">· ${esc(p.kind)} playbook on ${esc(p.venue)}</span></h3>
      <div class="chips"><span><b>${usd(p.cap)}</b> position</span><span><b>${usd(p.fees)}</b> fees, all steps</span><span><b>${p.hold} days</b> hold</span><span><b>${p.weeks}×10 min</b> upkeep</span><span>share at 5% ≈ <b>${usd(p.share)}</b></span></div>
      <ol class="steps"><li class="head"><span></span><p>Step</p><span class="cost">Cost</span><span class="time">Time</span></li>${steps}</ol></section></div></article>`;
  }

  // ---------- render and events ----------
  function render() {
    const rows = state.view === 'ranked' ? visibleRows() : [];
    const body = state.view === 'ranked'
      ? `${renderControls(rows)}<div class="split ${state.cat ? 'with-panel' : ''}">${renderBoard(rows)}${renderCategoryPanel(rows)}</div>`
      : renderList();
    const sel = rowsBySlug.get(state.p);
    root.innerHTML = renderTop() + renderLedger() + renderModel() + body + (sel ? renderDetail(sel) : '');
    root.removeAttribute('aria-busy');
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-view],[data-tier],[data-sort],[data-slug],[data-close],[data-clear]');
    if (!t) return;
    if (t.dataset.view) setState({ view: t.dataset.view, p: '' });
    else if (t.dataset.tier) setState({ tier: t.dataset.tier });
    else if (t.dataset.sort) setState({ sort: t.dataset.sort, dir: state.sort === t.dataset.sort && state.dir === 'desc' ? 'asc' : 'desc' });
    else if (t.dataset.slug) setState({ p: t.dataset.slug });
    else if (t.dataset.close) setState({ p: '' });
    else if (t.dataset.clear) setState({ q: '', cat: '', chain: '', tier: 'all' });
  });
  root.addEventListener('change', (e) => { if (e.target.id === 'cat' || e.target.id === 'chain') setState({ [e.target.id]: e.target.value }); });
  root.addEventListener('input', (e) => { if (e.target.id === 'q') { clearTimeout(root.t); root.t = setTimeout(() => setState({ q: e.target.value }), 250); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.p) setState({ p: '' }); });
  window.addEventListener('hashchange', () => { const q = document.getElementById('q'); if (q && state.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
  render();
})();
