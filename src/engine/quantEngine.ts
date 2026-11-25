/**
 * QuantPreflight MCP — Pure Deterministic Quantitative & Microstructure Math Kernel
 * - Salvaged & extended from Track A (`track-a-quant-workbench/src/lib/quantEngine.ts`)
 * - Zero browser dependencies, zero external runtime dependencies, zero network I/O
 * - Hardened against NaN, Infinity, zero-division, negative sizes, and thin orderbooks
 */

export class DomainMathError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainMathError';
    this.code = code;
  }
}

export function clampFinite(val: number, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

export function roundTo(val: number, decimals = 6): number {
  if (!Number.isFinite(val)) return 0;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

export function mulberry32(seed: number): () => number {
  const safeSeed = Number.isFinite(seed) ? seed : 20261125;
  let a = safeSeed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KellyResult {
  netWinR: number;
  netLossR: number;
  effectivePayoffRatio: number;
  breakevenWinRatePct: number;
  expectedValueR: number;
  zeroFeeFullKellyPct: number;
  kellyHaircutPctPoints: number;
  fullKellyPct: number;
  halfKellyPct: number;
  quarterKellyPct: number;
  frictionExceedsReward: boolean;
}

/**
 * Salvaged from Track A: Kelly Criterion with Round-Trip Fee & Slippage Drag
 */
export function computeKellyWithFriction(
  winRatePct: number,
  grossRewardRisk: number,
  roundTripFrictionR: number
): KellyResult {
  const p = clampFinite(winRatePct, 50, 0.1, 99.9) / 100;
  const q = 1 - p;
  const grossRR = clampFinite(grossRewardRisk, 1.5, 0.05, 100);
  const fricR = clampFinite(roundTripFrictionR, 0, 0, 10);

  const zeroFeeRaw = Math.max(0, Math.min(0.95, p - q / grossRR));
  const frictionExceedsReward = fricR >= grossRR;
  const rawNetWinR = grossRR - fricR;
  const netWinR = Math.max(0.0001, rawNetWinR);
  const netLossR = 1 + fricR;
  const bEff = frictionExceedsReward ? 0 : netWinR / netLossR;

  const rawKelly = frictionExceedsReward ? 0 : p / netLossR - q / netWinR;
  const fullKelly = Math.max(0, Math.min(0.95, rawKelly));
  const evR = p * rawNetWinR - q * netLossR;
  const breakevenWinRatePct = frictionExceedsReward
    ? 100
    : Math.min(100, Math.max(0, (netLossR / (netWinR + netLossR)) * 100));

  const zeroFeeFullKellyPct = zeroFeeRaw * 100;
  const fullKellyPct = fullKelly * 100;

  return {
    netWinR: roundTo(rawNetWinR, 6),
    netLossR: roundTo(netLossR, 6),
    effectivePayoffRatio: roundTo(bEff, 6),
    breakevenWinRatePct: roundTo(breakevenWinRatePct, 4),
    expectedValueR: roundTo(evR, 6),
    zeroFeeFullKellyPct: roundTo(zeroFeeFullKellyPct, 4),
    kellyHaircutPctPoints: roundTo(Math.max(0, zeroFeeFullKellyPct - fullKellyPct), 4),
    fullKellyPct: roundTo(fullKellyPct, 4),
    halfKellyPct: roundTo(fullKelly * 50, 4),
    quarterKellyPct: roundTo(fullKelly * 25, 4),
    frictionExceedsReward,
  };
}

export interface BreakevenResult {
  roundTripCostPct: number;
  frictionShareOfStopPct: number;
  nominalBreakevenWinPct: number;
  realBreakevenWinPct: number;
  winRatePenaltyPct: number;
  frictionInR: number;
  grossRewardRisk: number;
  impossibleTarget: boolean;
}

/**
 * Salvaged from Track A: Execution Fee, Spread & Slippage Breakeven Calculator
 */
export function computeExecutionBreakeven(params: {
  stopLossPct: number;
  takeProfitPct: number;
  roundTripCostBps: number;
}): BreakevenResult {
  const sl = clampFinite(params.stopLossPct, 0.4, 0.001, 95);
  const tp = clampFinite(params.takeProfitPct, 0.6, 0.001, 500);
  const rtBps = clampFinite(params.roundTripCostBps, 0, 0, 2000);

  const rtCostPct = rtBps / 100;
  const nominalBe = (sl / (tp + sl)) * 100;
  const impossibleTarget = tp <= rtCostPct;
  const netTp = Math.max(0.0001, tp - rtCostPct);
  const netSl = sl + rtCostPct;
  const realBe = impossibleTarget
    ? 100
    : Math.min(100, Math.max(0, (netSl / (netTp + netSl)) * 100));

  return {
    roundTripCostPct: roundTo(rtCostPct, 6),
    frictionShareOfStopPct: roundTo((rtCostPct / sl) * 100, 4),
    nominalBreakevenWinPct: roundTo(nominalBe, 4),
    realBreakevenWinPct: roundTo(realBe, 4),
    winRatePenaltyPct: roundTo(realBe - nominalBe, 4),
    frictionInR: roundTo(rtCostPct / sl, 6),
    grossRewardRisk: roundTo(tp / sl, 6),
    impossibleTarget,
  };
}

export interface PositionSizingSummary {
  maxRiskUsd: number;
  stopDistancePct: number;
  notionalUsd: number;
  units: number;
  effectiveLeverage: number;
  roundTripFeeUsd: number;
}

/**
 * Salvaged from Track A: Fee-Inclusive 1R Position Sizing
 */
export function computePositionSizing(params: {
  accountBalanceUsd: number;
  riskPct: number;
  entryPrice: number;
  stopDistancePct: number;
  roundTripCostBps: number;
}): PositionSizingSummary {
  const bal = clampFinite(params.accountBalanceUsd, 10000, 1, 1e11);
  const riskPct = clampFinite(params.riskPct, 1.0, 0.01, 100);
  const entry = clampFinite(params.entryPrice, 100000, 1e-8, 1e9);
  const stopDistPct = clampFinite(params.stopDistancePct, 1.0, 0.001, 95);
  const feeFrac = clampFinite(params.roundTripCostBps, 0, 0, 2000) / 10_000;

  const maxRiskUsd = bal * (riskPct / 100);
  const stopFrac = stopDistPct / 100;
  const totalUnitLossFrac = stopFrac + feeFrac;
  const notionalUsd = totalUnitLossFrac > 0 ? maxRiskUsd / totalUnitLossFrac : 0;
  const units = entry > 0 ? notionalUsd / entry : 0;

  return {
    maxRiskUsd: roundTo(maxRiskUsd, 4),
    stopDistancePct: roundTo(stopDistPct, 4),
    notionalUsd: roundTo(notionalUsd, 2),
    units: roundTo(units, 6),
    effectiveLeverage: roundTo(notionalUsd / bal, 4),
    roundTripFeeUsd: roundTo(notionalUsd * feeFrac, 4),
  };
}

/**
 * Salvaged from Track A: Exact Absorbing Markov Chain DP for >= k Consecutive Losses
 */
export function computeAbsorbingMarkovStreaks(
  winRatePct: number,
  horizonTrades: number,
  streakLengths: number[] = [4, 6, 8, 10, 12]
): { streak_length: number; probability_pct: number }[] {
  const p = clampFinite(winRatePct, 50, 0.1, 99.9) / 100;
  const q = 1 - p;
  const N = Math.round(clampFinite(horizonTrades, 300, 1, 10_000));

  return streakLengths.map((k) => {
    const safeK = Math.max(1, Math.round(k));
    let state = new Float64Array(safeK + 1);
    state[0] = 1.0;
    for (let n = 0; n < N; n++) {
      const next = new Float64Array(safeK + 1);
      next[safeK] = state[safeK]!;
      for (let j = 0; j < safeK; j++) {
        const sj = state[j]!;
        next[0] = next[0]! + sj * p;
        next[j + 1] = next[j + 1]! + sj * q;
      }
      state = next;
    }
    return {
      streak_length: safeK,
      probability_pct: roundTo(Math.min(100, Math.max(0, state[safeK]! * 100)), 4),
    };
  });
}

export interface L2BookLevel {
  price: number;
  size: number;
}

export interface L2BookWalkResult {
  book_side_swept: 'asks' | 'bids';
  best_bid: number;
  best_ask: number;
  mid_price: number;
  top_spread_bps: number;
  requested_order_usd: number;
  filled_order_usd: number;
  unfilled_order_usd: number;
  max_available_book_usd: number;
  insufficient_book_depth: boolean;
  levels_consumed: number;
  vwap_execution_price: number;
  slippage_vs_mid_bps: number;
  slippage_vs_touch_bps: number;
  slippage_cost_usd: number;
}

/**
 * Track B Extension 1: L2 Orderbook VWAP Book-Walk
 * Walks resting ask levels (for ask sweep) or bid levels (for bid sweep) to measure exact
 * volume-weighted execution price, slippage in bps, and liquidity exhaustion.
 */
export function walkOrderbookL2(params: {
  bids: L2BookLevel[];
  asks: L2BookLevel[];
  side: 'buy' | 'sell';
  orderSizeUsd: number;
}): L2BookWalkResult {
  if (!Number.isFinite(params.orderSizeUsd) || params.orderSizeUsd <= 0) {
    throw new DomainMathError('INVALID_ORDER_SIZE', 'order_size_usd must be a positive finite number.');
  }

  const validBids = params.bids
    .filter((b) => Number.isFinite(b.price) && Number.isFinite(b.size) && b.price > 0 && b.size > 0)
    .sort((a, b) => b.price - a.price);

  const validAsks = params.asks
    .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);

  if (validBids.length === 0 || validAsks.length === 0) {
    throw new DomainMathError(
      'EMPTY_ORDERBOOK',
      'Orderbook contains zero valid resting bid or ask levels.'
    );
  }

  const bestBid = validBids[0]!.price;
  const bestAsk = validAsks[0]!.price;
  if (bestAsk < bestBid) {
    throw new DomainMathError(
      'CROSSED_ORDERBOOK',
      `Corrupted crossed orderbook detected (bestAsk ${bestAsk} < bestBid ${bestBid}).`
    );
  }

  const midPrice = (bestBid + bestAsk) / 2;
  const topSpreadBps = ((bestAsk - bestBid) / midPrice) * 10_000;

  const bookSideSwept: 'asks' | 'bids' = params.side === 'buy' ? 'asks' : 'bids';
  const levels = bookSideSwept === 'asks' ? validAsks : validBids;
  const touchPrice = bookSideSwept === 'asks' ? bestAsk : bestBid;

  const targetUsd = params.orderSizeUsd;
  let remainingUsd = targetUsd;
  let filledUsd = 0;
  let filledBaseUnits = 0;
  let maxAvailableBookUsd = 0;
  let levelsConsumed = 0;

  for (const lvl of levels) {
    const levelNotionalUsd = lvl.price * lvl.size;
    maxAvailableBookUsd += levelNotionalUsd;

    if (remainingUsd > 1e-9) {
      const takeUsd = Math.min(remainingUsd, levelNotionalUsd);
      const takeUnits = takeUsd / lvl.price;
      filledUsd += takeUsd;
      filledBaseUnits += takeUnits;
      remainingUsd -= takeUsd;
      levelsConsumed += 1;
    }
  }

  const insufficientBookDepth = remainingUsd > Math.max(0.01, targetUsd * 1e-6);
  const vwapPrice = filledBaseUnits > 0 ? filledUsd / filledBaseUnits : touchPrice;
  const slippageVsMidBps = (Math.abs(vwapPrice - midPrice) / midPrice) * 10_000;
  const slippageVsTouchBps = (Math.abs(vwapPrice - touchPrice) / touchPrice) * 10_000;
  const slippageCostUsd = (slippageVsMidBps / 10_000) * filledUsd;

  return {
    book_side_swept: bookSideSwept,
    best_bid: roundTo(bestBid, 6),
    best_ask: roundTo(bestAsk, 6),
    mid_price: roundTo(midPrice, 6),
    top_spread_bps: roundTo(topSpreadBps, 4),
    requested_order_usd: roundTo(targetUsd, 2),
    filled_order_usd: roundTo(filledUsd, 2),
    unfilled_order_usd: roundTo(Math.max(0, targetUsd - filledUsd), 2),
    max_available_book_usd: roundTo(maxAvailableBookUsd, 2),
    insufficient_book_depth: insufficientBookDepth,
    levels_consumed: levelsConsumed,
    vwap_execution_price: roundTo(vwapPrice, 6),
    slippage_vs_mid_bps: roundTo(slippageVsMidBps, 4),
    slippage_vs_touch_bps: roundTo(slippageVsTouchBps, 4),
    slippage_cost_usd: roundTo(slippageCostUsd, 4),
  };
}

/**
 * Helper for Tool 2: Computes two-sided depth within X bps of mid price + symmetric market impact.
 */
export function summarizeOrderbookMicrostructure(bids: L2BookLevel[], asks: L2BookLevel[]) {
  const walk10kAsk = walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: 10_000 });
  const walk10kBid = walkOrderbookL2({ bids, asks, side: 'sell', orderSizeUsd: 10_000 });
  const walk100kAsk = walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: 100_000 });
  const walk100kBid = walkOrderbookL2({ bids, asks, side: 'sell', orderSizeUsd: 100_000 });

  const mid = walk10kAsk.mid_price;
  const bandFrac = 50 / 10_000; // +/- 50 bps (0.50%) depth band
  const bidDepth50BpsUsd = bids
    .filter((b) => Number.isFinite(b.price) && b.price >= mid * (1 - bandFrac))
    .reduce((acc, b) => acc + b.price * b.size, 0);
  const askDepth50BpsUsd = asks
    .filter((a) => Number.isFinite(a.price) && a.price <= mid * (1 + bandFrac))
    .reduce((acc, a) => acc + a.price * a.size, 0);

  return {
    mid_price: mid,
    top_spread_bps: walk10kAsk.top_spread_bps,
    bid_depth_50bps_usd: roundTo(bidDepth50BpsUsd, 2),
    ask_depth_50bps_usd: roundTo(askDepth50BpsUsd, 2),
    total_book_depth_usd: roundTo(
      walk10kAsk.max_available_book_usd + walk10kBid.max_available_book_usd,
      2
    ),
    impact_10k_bps: roundTo(
      (walk10kAsk.slippage_vs_mid_bps + walk10kBid.slippage_vs_mid_bps) / 2,
      4
    ),
    impact_100k_bps: roundTo(
      (walk100kAsk.slippage_vs_mid_bps + walk100kBid.slippage_vs_mid_bps) / 2,
      4
    ),
    depth_exhausted_at_100k:
      walk100kAsk.insufficient_book_depth || walk100kBid.insufficient_book_depth,
  };
}

export interface MonteCarloRealityResult {
  paths_simulated: number;
  num_trades: number;
  seed_used: number;
  gross_payoff_ratio: number;
  effective_net_payoff_ratio: number;
  round_trip_cost_bps: number;
  friction_in_r: number;
  nominal_breakeven_win_rate_pct: number;
  effective_breakeven_win_rate_pct: number;
  gross_ev_per_trade_r: number;
  net_ev_per_trade_r: number;
  ev_decay_pct: number;
  gross_terminal_multiple: {
    p5: number;
    median: number;
    p95: number;
  };
  net_terminal_multiple: {
    p5: number;
    median: number;
    p95: number;
  };
  ruin_drawdown_threshold_pct: number;
  gross_ruin_probability_pct: number;
  net_ruin_probability_pct: number;
  markov_losing_streak_probabilities: { streak_length: number; probability_pct: number }[];
  impossible_target_after_friction: boolean;
}

/**
 * Track B Extension 4: 5,000-Path Seeded Monte Carlo Reality Simulator
 * Compares frictionless paper backtest equity multiples against friction-injected net equity
 * across 5,000 deterministic trajectories using inline Mulberry32 + Float64Array sorting.
 */
export function simulateBacktestReality5000(params: {
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  numTrades: number;
  riskPerTradePct: number;
  roundTripCostBps: number;
  ruinDrawdownPct?: number;
  seed?: number;
  paths?: number;
}): MonteCarloRealityResult {
  const winRatePct = clampFinite(params.winRatePct, 50, 0.5, 99.5);
  const avgWinPct = clampFinite(params.avgWinPct, 0.8, 0.0001, 500);
  const avgLossPct = clampFinite(params.avgLossPct, 0.5, 0.0001, 99);
  const numTrades = Math.round(clampFinite(params.numTrades, 250, 10, 5000));
  const riskPct = clampFinite(params.riskPerTradePct, 1.0, 0.05, 50);
  const rtCostBps = clampFinite(params.roundTripCostBps, 10, 0, 2000);
  const ruinDdPct = clampFinite(params.ruinDrawdownPct ?? 30, 30, 5, 95);
  const seed = Number.isFinite(params.seed) ? Math.trunc(params.seed!) : 9052026;
  const paths = Math.round(clampFinite(params.paths ?? 5000, 5000, 100, 10_000));

  const p = winRatePct / 100;
  const q = 1 - p;
  const rFrac = riskPct / 100;
  const rtCostPct = rtCostBps / 100;

  const grossB = avgWinPct / avgLossPct;
  const frictionInR = rtCostPct / avgLossPct;
  const impossibleTarget = avgWinPct <= rtCostPct;

  const netWinR = grossB - frictionInR;
  const netLossR = 1 + frictionInR;
  const effectiveNetPayoff = impossibleTarget ? 0 : Math.max(0, netWinR) / netLossR;

  const nominalBePct = (avgLossPct / (avgWinPct + avgLossPct)) * 100;
  const effectiveBePct = impossibleTarget
    ? 100
    : Math.min(100, Math.max(0, (netLossR / (Math.max(0.0001, netWinR) + netLossR)) * 100));

  const grossEvR = p * grossB - q * 1.0;
  const netEvR = p * netWinR - q * netLossR;
  const evDecayPct =
    grossEvR > 1e-9 ? Math.min(200, Math.max(0, ((grossEvR - netEvR) / grossEvR) * 100)) : 0;

  const grossWinMult = Math.max(0, 1 + rFrac * grossB);
  const grossLossMult = Math.max(0, 1 - rFrac);
  const netWinMult = Math.max(0, 1 + rFrac * netWinR);
  const netLossMult = Math.max(0, 1 - rFrac * netLossR);

  const ruinFloor = 1 - ruinDdPct / 100;
  const grossFinals = new Float64Array(paths);
  const netFinals = new Float64Array(paths);

  let grossRuinedCount = 0;
  let netRuinedCount = 0;

  // Inlined Mulberry32 PRNG for <20ms execution across 5,000 paths
  let a = seed >>> 0;
  for (let s = 0; s < paths; s++) {
    let gEq = 1.0;
    let nEq = 1.0;
    let gRuined = false;
    let nRuined = false;

    for (let t = 0; t < numTrades; t++) {
      a = (a + 0x6d2b79f5) | 0;
      let tmp = Math.imul(a ^ (a >>> 15), 1 | a);
      tmp = (tmp + Math.imul(tmp ^ (tmp >>> 7), 61 | tmp)) ^ tmp;
      const u = ((tmp ^ (tmp >>> 14)) >>> 0) / 4294967296;

      if (u < p) {
        gEq *= grossWinMult;
        nEq *= netWinMult;
      } else {
        gEq *= grossLossMult;
        nEq *= netLossMult;
      }

      if (!gRuined && gEq <= ruinFloor) gRuined = true;
      if (!nRuined && nEq <= ruinFloor) nRuined = true;
    }

    if (gRuined) grossRuinedCount++;
    if (nRuined) netRuinedCount++;
    grossFinals[s] = Number.isFinite(gEq) ? Math.min(1e12, gEq) : 1e12;
    netFinals[s] = Number.isFinite(nEq) ? Math.min(1e12, nEq) : 1e12;
  }

  grossFinals.sort();
  netFinals.sort();

  const quantile = (sorted: Float64Array, qPct: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((sorted.length - 1) * qPct))
    );
    return roundTo(sorted[idx]!, 4);
  };

  const streaks = computeAbsorbingMarkovStreaks(winRatePct, numTrades, [4, 6, 8, 10, 12]);

  return {
    paths_simulated: paths,
    num_trades: numTrades,
    seed_used: seed,
    gross_payoff_ratio: roundTo(grossB, 4),
    effective_net_payoff_ratio: roundTo(effectiveNetPayoff, 4),
    round_trip_cost_bps: roundTo(rtCostBps, 4),
    friction_in_r: roundTo(frictionInR, 6),
    nominal_breakeven_win_rate_pct: roundTo(nominalBePct, 4),
    effective_breakeven_win_rate_pct: roundTo(effectiveBePct, 4),
    gross_ev_per_trade_r: roundTo(grossEvR, 6),
    net_ev_per_trade_r: roundTo(netEvR, 6),
    ev_decay_pct: roundTo(evDecayPct, 4),
    gross_terminal_multiple: {
      p5: quantile(grossFinals, 0.05),
      median: quantile(grossFinals, 0.5),
      p95: quantile(grossFinals, 0.95),
    },
    net_terminal_multiple: {
      p5: quantile(netFinals, 0.05),
      median: quantile(netFinals, 0.5),
      p95: quantile(netFinals, 0.95),
    },
    ruin_drawdown_threshold_pct: roundTo(ruinDdPct, 2),
    gross_ruin_probability_pct: roundTo((grossRuinedCount / paths) * 100, 4),
    net_ruin_probability_pct: roundTo((netRuinedCount / paths) * 100, 4),
    markov_losing_streak_probabilities: streaks,
    impossible_target_after_friction: impossibleTarget,
  };
}
