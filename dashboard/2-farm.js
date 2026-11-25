/* Token Radar farm plans. Each ranked protocol gets steps built from its own record:
 * - category picks the mechanism (vault deposit, supply and borrow, mint, LP, margin, KYC subscription...)
 * - chains pick the venue and the fee per transaction (named chains, never protocols)
 * - TVL sizes the position; days with no token set the hold; the 7-day change adds a caution step or not
 * Every step carries a dollar cost and a time; the plan totals its cost, setup minutes and active time.
 * Steps that do not apply are left out. Fees, rates and the 5% depositor share are stated assumptions.
 */
(function (root) {
  'use strict';
  const M = root.RadarModel || require('./1-model.js');
  const usd = M.usd;

  /** Fee per transaction in dollars, late-2026 estimates by chain. Chains not listed: an L2-class $0.05. */
  const TX_FEE = { Ethereum: 1.5, Bitcoin: 2.5, Tron: 0.8, Cardano: 0.2, Litecoin: 0.05, Doge: 0.1, Solana: 0.01, Sui: 0.01, Aptos: 0.01, Stellar: 0.01, Ripple: 0.01, Algorand: 0.01, Noble: 0.02, Cosmos: 0.02, TON: 0.03, Near: 0.01, Hedera: 0.01, Bittensor: 0.01 };
  const fee = (chain) => (chain in TX_FEE ? TX_FEE[chain] : 0.05);
  /** What a position is funded with: the chain's own asset where stablecoins do not live, else USDC. */
  const NATIVE = { Bitcoin: 'BTC', Bittensor: 'TAO', Litecoin: 'LTC', Doge: 'DOGE', Cardano: 'ADA' };
  const assetOn = (chain) => NATIVE[chain] || 'USDC';
  const CARRY_APR = 0.045; // what idle dollars earn elsewhere: the cost of a position that earns nothing
  const DEPOSITOR_SHARE = 0.05; // the share of a token assumed to reach depositors, for the position's share line

  /** Category to mechanism. Categories only. */
  const KIND = {
    vault: ['Risk Curators', 'Onchain Capital Allocator', 'Yield Aggregator', 'Liquidity Manager', 'Farm', 'Indexes'],
    yield: ['Yield', 'Leveraged Farming', 'Governance Incentives', 'DOR'],
    lend: ['Lending', 'Uncollateralized Lending', 'Collateral Markets', 'Collateral Management'],
    mint: ['CDP', 'CDP Manager', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Stablecoin Issuer', 'Algo-Stables', 'Reserve Currency'],
    basis: ['Basis Trading', 'CeDeFi'],
    rwa: ['RWA'],
    dex: ['Dexs', 'OTC Marketplace'],
    perp: ['Derivatives', 'Interest Rate Derivatives', 'Options', 'Options Vault', 'Synthetics', 'Prediction Market'],
    stake: ['Staking Pool', 'Restaking', 'Chain'],
    pay: ['Payments', 'Crypto Card Issuer', 'Privacy'],
    cover: ['Insurance'],
  };
  const KIND_OF = {};
  for (const k of Object.keys(KIND)) for (const c of KIND[k]) KIND_OF[c] = k;

  /**
   * The mechanism's two working steps: [do, transactions, minutes, extra dollar cost]. `c` is the plan's
   * context: name, venue, cap (position), plus derived amounts.
   */
  const PLAYBOOK = {
    vault: (c) => [[`Deposit ${usd(c.cap)} of ${c.asset} into ${c.name}'s largest ${c.asset === 'USDC' ? 'stablecoin' : c.asset} vault on ${c.venue}; confirm the vault address from the protocol's own app before approving.`, 2, 15, 0],
      [`Keep the vault shares in the wallet; do not wrap or lend them elsewhere unless the protocol says points follow the wrapper.`, 0, 5, 0]],
    yield: (c) => [[`Deposit ${usd(c.cap)} of ${c.asset} (or the asset the product takes) into ${c.name}'s main yield product on ${c.venue} and stake the receipt if a staking step exists.`, 3, 15, 0],
      [`Leave the receipt staked; claim nothing early, since early claims often reset a points multiplier.`, 0, 5, 0]],
    lend: (c) => [[`Supply ${usd(c.cap)} of ${c.asset} to ${c.name} on ${c.venue} as collateral.`, 2, 10, 0],
      [`Borrow ${usd(c.cap * 0.3)} of another asset (30% loan-to-value, far from liquidation) and resupply it, so the position counts on both sides; borrow interest at about 6% a year is the extra cost.`, 2, 10, c.cap * 0.3 * 0.06 * c.hold / 365]],
    mint: (c) => [[`Deposit ${usd(c.cap)} of collateral in ${c.name} on ${c.venue} and mint ${usd(c.cap * 0.4)} of its stablecoin (40% loan-to-value).`, 3, 15, 0],
      [`Put the minted stablecoin into the protocol's own savings or stability pool, the deposit its points usually track.`, 2, 10, 0]],
    basis: (c) => [[`Mint ${usd(c.cap)} of ${c.name}'s yield-bearing dollar on ${c.venue} from ${c.asset}.`, 2, 10, c.cap * 0.001],
      [`Stake the minted dollar in the protocol's staking or locked tier; note the unstaking cooldown before you commit.`, 2, 10, 0]],
    rwa: (c) => [[`Subscribe ${usd(c.cap)} to ${c.name}'s main tokenized product on ${c.venue} once onboarding clears; check the product's own minimum first.`, 2, 15, 0],
      [`Hold the product token in the onboarded wallet; transfers to other wallets can break eligibility.`, 0, 5, 0]],
    dex: (c) => [[`Provide ${usd(c.cap)} of liquidity to ${c.name}'s deepest ${c.asset === 'USDC' ? 'stablecoin or major' : c.asset} pair on ${c.venue}, a wide range if the pool is concentrated.`, 3, 20, 0],
      [`Swap ${usd(c.cap * 0.5)} through ${c.name} once a week, since many DEX programs score volume as well as liquidity; at about 0.1% a swap.`, 1, 5, c.cap * 0.5 * 0.001 * c.weeks + c.weeks * 0.05]],
    perp: (c) => [[`Deposit ${usd(c.cap)} of ${c.asset} as margin on ${c.name} on ${c.venue}.`, 2, 10, 0],
      [`Trade ${usd(c.cap * 2)} of notional a week in small, hedged positions (long and short, or one position closed the same day); at about 0.05% a side.`, 0, 15, c.cap * 2 * 0.001 * c.weeks]],
    stake: (c) => [[`Stake or delegate ${usd(c.cap)} of the network's asset through ${c.name} on ${c.venue}; pick an operator with a long record over the highest rate.`, 2, 15, 0],
      [`Restake or compound rewards each week if the protocol allows it; note the unbonding period before you start.`, 1, 5, 0]],
    pay: (c) => [[`Open ${c.name}'s wallet or channel on ${c.venue} with ${usd(c.cap)} and route payments through it on most weeks of the hold; opening is one on-chain transaction.`, 4, 20, 0],
      [`Send or spend at least one payment a week through it; usage counts as much as balance for payment products.`, 1, 5, 0]],
    cover: (c) => [[`Provide ${usd(c.cap)} of cover capital to ${c.name} on ${c.venue}; read which events pay out and the lockup.`, 2, 15, 0],
      [`Stay in through at least one cover period; capital is at risk if a covered event pays out.`, 0, 5, 0]],
  };

  /** A whole number of dollars a farmer can type: 250, 500, 1,000, 2,500, 5,000. */
  function positionSize(tvl, venueFee) {
    const steps = [250, 500, 1000, 2500, 5000];
    const want = Math.max(tvl * 5e-6, venueFee * 6 * 100); // 5 dollars per million of TVL, and six transactions under 1% of it
    return steps.filter((s) => s <= want).pop() || 250;
  }

  /** Hold days from days with no token: young protocols run longer seasons; old ones may snapshot sooner. */
  function holdDays(days) { return days === null ? 60 : days < 180 ? 90 : days < 540 ? 60 : 45; }

  /** The venue: the cheapest of the protocol's first three chains (DefiLlama lists the largest first). */
  function pickVenue(chains) {
    const first = chains.slice(0, 3);
    return first.reduce((best, ch) => (fee(ch) < fee(best) ? ch : best), first[0] || 'its main chain');
  }

  const minutes = (m) => (m >= 60 ? `${+(m / 60).toFixed(1)} h` : `${m} min`);
  const money = (n) => (n === 0 ? '$0' : n < 0.01 ? 'under $0.01' : n < 10 ? '$' + n.toFixed(2) : usd(n));
  /** DefiLlama's chain names, as a reader would look them up. */
  const chainName = (ch) => ({ Binance: 'BNB Chain', Op_Bnb: 'opBNB', Ripple: 'XRP Ledger' }[ch] || ch);
  /** Chains large exchanges withdraw to directly; any other is reached through its bridge from Ethereum. */
  const EXCHANGE_CHAINS = ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'Binance', 'Solana', 'Avalanche', 'Tron', 'Sui', 'Aptos', 'Bitcoin', 'Ripple', 'Stellar', 'Algorand', 'TON', 'Near', 'Cardano', 'Litecoin', 'Doge', 'Mantle', 'Linea', 'zkSync Era', 'Sonic', 'Hyperliquid L1', 'Plasma', 'Noble', 'Cosmos', 'Hedera', 'Bittensor', 'Celo', 'Scroll', 'Unichain', 'Kava'];
  /** Kinds whose position earns its own yield, so holding it forgoes nothing. */
  const EARNS = ['vault', 'yield', 'lend', 'mint', 'basis', 'rwa', 'dex', 'stake', 'cover'];

  /** A protocol's farm plan: steps with cost and time, and the plan's totals. */
  function farmPlan(r) {
    const kind = KIND_OF[r.category] || 'vault';
    const venue = pickVenue(r.chains), f = fee(venue), where = chainName(venue);
    const hold = holdDays(r.days), weeks = Math.ceil(hold / 7);
    const cap = positionSize(r.tvl, f);
    const asset = assetOn(venue);
    const c = { name: r.name, venue: where, cap, hold, weeks, asset };
    const steps = [];
    const add = (text, usdCost, mins, timeText, costText) => steps.push({ do: text, fee: usdCost, min: mins, cost: costText || money(usdCost), time: timeText || minutes(mins) });

    const reserve = Math.max(1, f * 12); // gas for about a dozen transactions, spent by the steps below
    if (EXCHANGE_CHAINS.includes(venue)) add(`Fund a fresh wallet on ${where} with ${usd(cap)} of ${asset} plus ${money(reserve)} of gas, withdrawn straight from an exchange to ${where}.`, 1, 20, null, `${money(1)} withdrawal fee`);
    else add(`Fund a fresh wallet with ${usd(cap)} of ${asset} on Ethereum and move it to ${where} through ${where}'s official bridge, plus ${money(reserve)} of gas there.`, 3 + TX_FEE.Ethereum, 30, '30 min with bridge wait', `${money(3 + TX_FEE.Ethereum)} bridge and L1 gas`);
    if (kind === 'rwa') add(`Complete ${r.name}'s investor onboarding (KYC, and KYB for a company); some tokenized products accept only qualified or non-US investors.`, 0, 30, '30 min to fill in, 1 to 3 days to clear', '$0');
    for (const [text, txs, mins, extra] of PLAYBOOK[kind](c)) add(text, txs * f + extra, mins);
    const alt = r.chains.slice(1).find((ch) => ch !== venue && fee(ch) <= 0.1);
    if (alt && cap >= 1000) add(`Move 30% (${usd(cap * 0.3)}) to ${r.name} on ${chainName(alt)} as a second position; protocols live on ${r.chains.length} chains often weight multi-chain users.`, cap * 0.3 * 0.001 + 4 * fee(alt), 20);
    const g = r.change7d;
    if (g !== null && g <= -10) add(`TVL fell ${Math.abs(g).toFixed(1)}% in seven days: enter in two halves a week apart, and withdraw if TVL falls another 25%.`, 2 * f, 10, '10 min now, 5 min a week to check');
    else if (g !== null && g >= 10) add(`TVL rose ${g.toFixed(1)}% in seven days: points per dollar dilute as deposits arrive, so enter this week rather than waiting for a dip.`, 0, 5, '5 min', '$0');
    const setup = steps.reduce((m, x) => m + x.min, 0) + 15; // every step so far is done once, on entry; exit is 15 min
    add(`Check the position and any points page once a week for ${weeks} weeks; reading costs nothing, a gas top-up is one transfer.`, f, weeks * 10, `10 min a week, ${weeks} weeks`);
    const carry = EARNS.includes(kind) ? 0 : cap * CARRY_APR * hold / 365;
    const share = DEPOSITOR_SHARE * r.implied * cap / r.tvl;
    add(`Hold for ${hold} days with no withdrawals so the position spans several snapshots; if ${DEPOSITOR_SHARE * 100}% of the ${usd(r.implied)} implied value went to depositors pro rata, this position's share would be about ${usd(share)}.`, carry, 0, `${hold} days`,
      carry ? `${money(carry)} idle-cash yield forgone at ${CARRY_APR * 100}%` : '$0: the position earns its own yield');
    add(`Exit: claim only from links on ${r.name}'s own site, then withdraw in one transaction and record the dates and amounts for tax.`, 2 * f, 15);

    const cost = steps.reduce((t, x) => t + x.fee, 0);
    return { kind, venue: where, asset, cap, hold, weeks, steps, cost, share, setup, active: setup + weeks * 10 };
  }

  const api = { farmPlan, positionSize, holdDays, pickVenue, TX_FEE, KIND };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarFarm = api;
})(typeof window !== 'undefined' ? window : globalThis);
