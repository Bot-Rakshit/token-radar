/* Token Radar value model, "peers-eb-1". One file, loaded by the page (window.RadarModel) and by main.ts
 * (require), so board.json and every number on screen come from the same functions.
 *
 * What a protocol's token would be worth if its record stayed as it is:
 *   implied = peerMultiple(category) x tvlTerm(TVL) x growthTerm(7d change) x noTokenAgeTerm(days with no token)
 * - peerMultiple: what the market pays per dollar of TVL for tokens that already trade, read from this
 *   snapshot's own live-token protocols ("peers"), by category, shrunk toward the category's family and the
 *   whole peer set when a category has few peers (empirical Bayes; credibility n / (n + K)).
 * - tvlTerm: peers show mcap rising slower than TVL; the slope is fitted here (fitScaleSlope), half of it is used.
 * - growthTerm and noTokenAgeTerm: stated, bounded priors (the peers cannot fit them), each x0.84 to x1.19.
 * No protocol is named anywhere in this source: the lists below name categories, and the same functions
 * score every row.
 */
(function (root) {
  'use strict';

  /** Every constant of the model, with where it comes from. */
  const CONFIG = {
    version: 'peers-eb-1',
    winsor: [0.05, 0.95], // peer multiples are clipped at the peer set's own 5th and 95th percentiles
    credibility_k: 5, // a category with K peers gets half its own estimate, half its family's
    min_own_peers: 2, // one traded peer is an anecdote, not a price: below this a category takes its family's
    slope_damping: 0.5, // use half the fitted size slope: part of it is small records carrying a whole token's cap
    growth_clamp: [-50, 100], // per cent; a week's change beyond these is not read further
    growth_elasticity: 0.25, // a quarter of the week's TVL change carries into value
    age_full_days: 1095, // three years with no token earns the full durability credit
    age_range: [0.85, 1.15], // durability term from 0 days to age_full_days; undated records get 1.00
    band: [0.25, 0.75], // low/high: the peer pool's quartile multiples
    flat_multiple: 0.25, // the house starter's flat TVL multiple, kept only as the backtest's baseline
  };

  /** Categories, never protocols: each maps to a family that pools its peers. */
  const FAMILY = {
    'Vaults & yield': ['Risk Curators', 'Onchain Capital Allocator', 'Yield', 'Yield Aggregator', 'Liquidity Manager', 'Leveraged Farming', 'Farm', 'Indexes', 'Governance Incentives', 'DOR'],
    'Credit & stables': ['Lending', 'CDP', 'CDP Manager', 'Uncollateralized Lending', 'Collateral Markets', 'Collateral Management', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Stablecoin Issuer', 'Algo-Stables', 'Reserve Currency'],
    'Trading': ['Dexs', 'Derivatives', 'Options', 'Options Vault', 'Interest Rate Derivatives', 'Prediction Market', 'Synthetics', 'OTC Marketplace', 'NFT Marketplace'],
    'RWA & basis': ['RWA', 'Basis Trading', 'CeDeFi', 'Insurance'],
    'Staking': ['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool', 'Restaked BTC', 'Anchor BTC', 'Decentralized BTC'],
    'Chains & apps': ['Chain', 'Payments', 'Privacy', 'AI Agents', 'Decentralized AI', 'Token Locker', 'Launchpad', 'Crypto Card Issuer', 'Bridge', 'Canonical Bridge', 'Cross Chain Bridge'],
  };
  const FAMILY_OF = {};
  for (const f of Object.keys(FAMILY)) for (const c of FAMILY[f]) FAMILY_OF[c] = f;
  const familyOf = (category) => FAMILY_OF[category] || 'Chains & apps';

  /** The house watchlist's own tests, applied to every protocol, plus custodial and wrapper categories. */
  const SET_ASIDE_CATEGORIES = ['CEX', 'Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Anchor BTC', 'Decentralized BTC'];
  const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  const WRAPPER_WORD = /\b(wrapped|staked|staking|bridge|bridged)\b/i;
  const brandOf = (name) => name.toLowerCase().split(/[\s.\-_]+/)[0];

  // ---------- small numeric helpers ----------
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => sum(a) / a.length;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  function quantile(sorted, q) {
    if (sorted.length === 0) return NaN;
    const at = (sorted.length - 1) * q, i = Math.floor(at), f = at - i;
    return i + 1 < sorted.length ? sorted[i] + f * (sorted[i + 1] - sorted[i]) : sorted[i];
  }
  const sortedNums = (a) => a.slice().sort((x, y) => x - y);
  const DAY_MS = 86400000;
  function daysBetween(from, to) {
    if (!from) return null;
    const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.floor((b - a) / DAY_MS)) : null;
  }

  // ---------- 1. who is who: separate tokens that trade from protocols still to come ----------

  /** A protocol's token status from its record: 'trades' (market cap), 'recorded' (id or ticker, no cap), 'none'. */
  function tokenStatus(p) {
    if (p.mcap_usd > 0) return 'trades';
    if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return 'recorded';
    return 'none';
  }

  /**
   * Sorts all protocols into the ledger: 'watchlist', 'early' (ranked below the floor), 'trades',
   * 'recorded' or 'aside', with the reason for each one set aside.
   */
  function separateTokenStatus(snapshot) {
    const watch = new Set(snapshot.watchlist);
    const tokenBrands = new Map();
    for (const p of snapshot.protocols) if (tokenStatus(p) !== 'none') tokenBrands.set(brandOf(p.name), p.symbol || p.gecko_id || 'a token');
    const ledger = [];
    for (const p of snapshot.protocols) {
      const status = tokenStatus(p);
      let group, reason = null, caution = null;
      if (watch.has(p.slug)) {
        group = 'watchlist';
        const t = tokenBrands.get(brandOf(p.name));
        if (t) caution = `a sibling record under the same brand carries ${t}: DefiLlama's record is not proof of no token`;
      } else if (status === 'trades') { group = 'trades'; reason = 'token trades: market cap recorded'; }
      else if (status === 'recorded') { group = 'recorded'; reason = 'token recorded (id or ticker), market cap zero or missing'; }
      else { reason = setAsideReason(p, snapshot.floor_usd, tokenBrands); group = reason ? 'aside' : 'early'; }
      ledger.push({ p, group, reason, caution });
    }
    return ledger;
  }

  /** Why a protocol with no token recorded is still left off the board, or null to rank it. */
  function setAsideReason(p, floor, tokenBrands) {
    if (SET_ASIDE_CATEGORIES.includes(p.category)) return `${p.category}: custodial or wrapped product of an existing asset`;
    if (VERSIONED.test(p.name)) return 'versioned pool of another protocol';
    if (WRAPPER_WORD.test(p.name)) return 'wrapped, staked or bridged product by its name';
    if (tokenBrands.has(brandOf(p.name))) return `same brand as a record carrying ${tokenBrands.get(brandOf(p.name))}`;
    // The house watchlist takes every protocol at or above the floor that passes the tests above unless
    // DefiLlama records a parent protocol for it, so one that passes them all and is still off the list has
    // a parent on record. The snapshot omits the field; the published rule and its output pin it down.
    if (p.tvl_usd >= floor) return 'above the floor yet off the house watchlist: DefiLlama records a parent protocol';
    return null;
  }

  // ---------- 2. calibration on the peers: what traded tokens are worth per dollar of TVL ----------

  /**
   * Live-token protocols whose market cap belongs to their own TVL: the model's peers. Left out: exchanges,
   * versioned pools and wrapped or staked names (the cap is a parent's), tickers or ids shared by several
   * records (one cap, many TVLs), and receipts whose cap equals their TVL within 2% (the cap is the deposits).
   */
  function selectLivePeers(snapshot) {
    const shared = new Map();
    const count = (k) => k && shared.set(k.toLowerCase(), (shared.get(k.toLowerCase()) || 0) + 1);
    for (const p of snapshot.protocols) { count(p.symbol); count(p.gecko_id && 'id:' + p.gecko_id); }
    const isShared = (p) => (p.symbol && shared.get(p.symbol.toLowerCase()) > 1) || (p.gecko_id && shared.get('id:' + p.gecko_id.toLowerCase()) > 1);
    return snapshot.protocols
      .filter((p) => p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX' && !VERSIONED.test(p.name) && !/\b(wrapped|staked|staking)\b/i.test(p.name) && !/^st[A-Z]{2,}/.test(p.name) && !isShared(p) && Math.abs(p.mcap_usd / p.tvl_usd - 1) > 0.02)
      .map((p) => ({ slug: p.slug, name: p.name, category: p.category, family: familyOf(p.category), tvl: p.tvl_usd, mcap: p.mcap_usd, raw: p.mcap_usd / p.tvl_usd }));
  }

  /** The size slope: pooled within-family least squares of ln(mcap/TVL) on ln(TVL). Negative: big TVL, thin multiple. */
  function fitScaleSlope(peers) {
    const groups = {};
    for (const q of peers) (groups[q.family] = groups[q.family] || []).push(q);
    let sxy = 0, sxx = 0;
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      const mx = mean(g.map((q) => Math.log(q.tvl))), my = mean(g.map((q) => Math.log(q.raw)));
      for (const q of g) { sxy += (Math.log(q.tvl) - mx) * (Math.log(q.raw) - my); sxx += (Math.log(q.tvl) - mx) ** 2; }
    }
    return sxx > 0 ? sxy / sxx : 0;
  }

  /**
   * Fits the multiples: each peer's multiple restated at the floor's TVL (removing the size slope), clipped at
   * the peer set's own percentiles, then averaged in log space per family and per category with shrinkage.
   */
  function calibrate(peers, floor) {
    const slope = fitScaleSlope(peers);
    const gamma = clamp(-slope * CONFIG.slope_damping, 0, 0.5);
    const atFloor = peers.map((q) => Math.log(q.raw) + gamma * Math.log(q.tvl / floor));
    const s = sortedNums(atFloor), lo = quantile(s, CONFIG.winsor[0]), hi = quantile(s, CONFIG.winsor[1]);
    const pts = peers.map((q, i) => ({ ...q, z: clamp(atFloor[i], lo, hi) }));
    const K = CONFIG.credibility_k, global = mean(pts.map((q) => q.z));
    const fam = {}, cat = {};
    for (const q of pts) { (fam[q.family] = fam[q.family] || []).push(q); (cat[q.category] = cat[q.category] || []).push(q); }
    const famMu = {};
    for (const f of Object.keys(FAMILY)) famMu[f] = shrink(fam[f] || [], global, K);
    return { slope, gamma, floor, winsor: [Math.exp(lo), Math.exp(hi)], global, pts, fam, cat, famMu, K };
  }

  /** Credibility-weighted log mean: n/(n+K) on the group's own mean, the rest on the prior. */
  function shrink(group, prior, K) {
    const n = group.length;
    return n === 0 ? prior : (n * mean(group.map((q) => q.z)) + K * prior) / (n + K);
  }

  /** A category's multiple at the floor's TVL, with how it was made: own peers, weight, family. */
  function peerMultiple(cal, category) {
    const family = familyOf(category), famMu = cal.famMu[family], all = cal.cat[category] || [];
    const own = all.length >= CONFIG.min_own_peers ? all : [];
    const weight = own.length / (own.length + cal.K);
    const mu = shrink(own, famMu, cal.K);
    // The band's pool: the category's own peers when it has 5, else the family's, else all peers.
    const pool = own.length >= 5 ? own : (cal.fam[family] || []).length >= 5 ? cal.fam[family] : cal.pts;
    const zs = sortedNums(pool.map((q) => q.z)), mid = quantile(zs, 0.5);
    return {
      family, peers: own, set: all, weight, multiple: Math.exp(mu), familyMultiple: Math.exp(famMu), ownMultiple: own.length ? Math.exp(mean(own.map((q) => q.z))) : null,
      lowFactor: Math.exp(quantile(zs, CONFIG.band[0]) - mid), highFactor: Math.exp(quantile(zs, CONFIG.band[1]) - mid),
      bandPool: pool === own ? 'category' : pool === cal.pts ? 'all peers' : 'family', bandN: pool.length,
    };
  }

  // ---------- 3. the three named terms ----------

  /** Size: the multiple is set at the floor's TVL; a protocol 10x larger gets 10^(1-gamma)x the value. */
  function tvlTerm(cal, tvl) { return Math.pow(tvl / cal.floor, -cal.gamma); }

  /** Seven-day TVL growth, clamped, a quarter of it carried into value. Unreported growth: x1.00. */
  function growthTerm(change7d) {
    if (change7d === null || !Number.isFinite(change7d)) return 1;
    return Math.pow(1 + clamp(change7d, CONFIG.growth_clamp[0], CONFIG.growth_clamp[1]) / 100, CONFIG.growth_elasticity);
  }

  /**
   * Days tracked with no token recorded: TVL that has stayed for years with no token to hold it is durable;
   * weeks-old TVL is often points capital that leaves at launch. Linear from x0.85 (new) to x1.15 (3 years).
   */
  function noTokenAgeTerm(days) {
    if (days === null) return 1;
    const [a, b] = CONFIG.age_range;
    return a + (b - a) * Math.min(days, CONFIG.age_full_days) / CONFIG.age_full_days;
  }

  /** One protocol's implied value and every step of its working. */
  function impliedValue(cal, p, asOf) {
    const pm = peerMultiple(cal, p.category);
    const days = daysBetween(p.listed_at, asOf);
    const size = tvlTerm(cal, Math.max(1, p.tvl_usd)), growth = growthTerm(p.change_7d), age = noTokenAgeTerm(days);
    const effective = pm.multiple * size * growth * age;
    const implied = Math.max(1, Math.round(p.tvl_usd * effective));
    return {
      implied, low: Math.max(1, Math.round(implied * pm.lowFactor)), high: Math.max(1, Math.round(implied * pm.highFactor)),
      effective, size, growth, age, days, pm,
    };
  }

  // ---------- 4. the backtest: does the multiple predict traded tokens it never saw? ----------

  /** Leave-one-out on the peers: refit everything without peer j, predict its market cap, compare. */
  function runBacktest(peers, floor) {
    const miss = { model: [], flat: [], category: [] };
    for (let j = 0; j < peers.length; j++) {
      const q = peers[j], rest = peers.filter((_, i) => i !== j), cal = calibrate(rest, floor);
      const pred = q.tvl * peerMultiple(cal, q.category).multiple * tvlTerm(cal, q.tvl);
      const same = sortedNums(rest.filter((r) => r.category === q.category).map((r) => r.raw));
      const naive = q.tvl * (same.length ? quantile(same, 0.5) : CONFIG.flat_multiple);
      miss.model.push(Math.abs(Math.log(pred / q.mcap)));
      miss.flat.push(Math.abs(Math.log((q.tvl * CONFIG.flat_multiple) / q.mcap)));
      miss.category.push(Math.abs(Math.log(naive / q.mcap)));
    }
    const summary = (a) => ({ median: Math.exp(quantile(sortedNums(a), 0.5)), within3: a.filter((x) => x <= Math.log(3)).length / a.length });
    return { n: peers.length, model: summary(miss.model), flat: summary(miss.flat), category: summary(miss.category) };
  }

  // ---------- 5. the radar ----------

  /** Everything the page and board.json need, from the snapshot alone. */
  function buildRadar(snapshot) {
    const asOf = snapshot.as_of, floor = snapshot.floor_usd;
    const peers = selectLivePeers(snapshot);
    const cal = calibrate(peers, floor);
    const ledger = separateTokenStatus(snapshot);
    const ranked = ledger.filter((e) => e.group === 'watchlist' || e.group === 'early').map((e) => {
      const v = impliedValue(cal, e.p, asOf);
      return { slug: e.p.slug, name: e.p.name, category: e.p.category, chains: e.p.chains, tvl: e.p.tvl_usd, change7d: e.p.change_7d, listed: e.p.listed_at, tier: e.group, caution: e.caution, ...v };
    });
    ranked.sort((a, b) => b.implied - a.implied || bySlug(a, b));
    ranked.forEach((r, i) => { r.rank = i + 1; });
    const farm = root.RadarFarm || (typeof require === 'function' ? require('./2-farm.js') : null);
    for (const r of ranked) r.plan = farm.farmPlan(r);
    const groups = {};
    for (const e of ledger) groups[e.group] = (groups[e.group] || 0) + 1;
    return {
      as_of: asOf, floor, config: CONFIG, cal, peers: cal.pts, rows: ranked, ledger, backtest: runBacktest(peers, floor),
      summary: { protocols: snapshot.protocols.length, watchlist: groups.watchlist || 0, early: groups.early || 0, trades: groups.trades || 0, recorded: groups.recorded || 0, set_aside: groups.aside || 0, peers: peers.length },
    };
  }

  /** board.json's rows: the gate's five fields plus the working. Farm steps as one string each. */
  function boardRows(radar) {
    return radar.rows.map((r) => ({
      rank: r.rank, slug: r.slug, name: r.name, implied_value_usd: r.implied,
      implied_low_usd: r.low, implied_high_usd: r.high, tier: r.tier, category: r.category, tvl_usd: r.tvl, change_7d: r.change7d,
      days_without_token: r.days, peer_multiple: +r.pm.multiple.toFixed(4), terms: { tvl: +r.size.toFixed(4), growth: +r.growth.toFixed(4), no_token_age: +r.age.toFixed(4) },
      farm_steps: r.plan.steps.map((s) => `${s.do} Cost: ${s.cost}. Time: ${s.time}.`),
    }));
  }

  /** Recomputes every row in the page and compares it with board.json's value: the parity line on screen. */
  function checkParity(radar, boardValues) {
    let match = 0;
    const off = [];
    for (const r of radar.rows) (boardValues && boardValues[r.slug] === r.implied ? match++ : off.push(r.slug));
    return { match, total: radar.rows.length, off };
  }

  /** $2.75B, $303.8M, $950K, $1,250: one formatter for the board, the page and the farm steps. */
  function usd(n) {
    const a = Math.abs(n), s = n < 0 ? '-$' : '$';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'K';
    if (a >= 100) return s + String(Math.round(a)).replace(/\B(?=(\d{3})+$)/g, ',');
    return s + (a >= 10 ? a.toFixed(0) : a.toFixed(2));
  }

  const api = { CONFIG, FAMILY, MODEL_VERSION: CONFIG.version, familyOf, tokenStatus, separateTokenStatus, setAsideReason, selectLivePeers, fitScaleSlope, calibrate, peerMultiple, tvlTerm, growthTerm, noTokenAgeTerm, impliedValue, runBacktest, buildRadar, boardRows, checkParity, usd, daysBetween };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
