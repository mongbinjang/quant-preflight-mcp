import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  type OhlcvCandle,
  auditFeatureCollinearity,
  buildIndicatorMatrixFromCandles,
  computeWilderAtr,
} from '../src/engine/indicators.js';
import {
  DomainMathError,
  clampFinite,
  computeAbsorbingMarkovStreaks,
  computeExecutionBreakeven,
  computeKellyWithFriction,
  computePositionSizing,
  mulberry32,
  roundTo,
  simulateBacktestReality5000,
  summarizeOrderbookMicrostructure,
  walkOrderbookL2,
} from '../src/engine/quantEngine.js';

function makeSyntheticCandles(count: number, seed = 42): OhlcvCandle[] {
  const rng = mulberry32(seed);
  const out: OhlcvCandle[] = [];
  let price = 100_000;
  const startTs = 1_760_000_000_000;

  for (let i = 0; i < count; i++) {
    const shock = (rng() - 0.495) * 0.012;
    const open = price;
    const close = Math.max(10, open * (1 + shock));
    const high = Math.max(open, close) * (1 + rng() * 0.004);
    const low = Math.min(open, close) * (1 - rng() * 0.004);
    const volume = 100 + rng() * 900;
    out.push({
      timestamp: startTs + i * 3_600_000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return out;
}

describe('Phase 1: Core Deterministic Math & Linear Algebra Engine (25+ Edge Cases)', () => {
  it('1. clampFinite guards NaN, +Infinity, -Infinity, and out-of-bounds values', () => {
    expect(clampFinite(Number.NaN, 15, 0, 100)).toBe(15);
    expect(clampFinite(Number.POSITIVE_INFINITY, 15, 0, 100)).toBe(15);
    expect(clampFinite(Number.NEGATIVE_INFINITY, 15, 0, 100)).toBe(15);
    expect(clampFinite(-20, 15, 0, 100)).toBe(0);
    expect(clampFinite(999, 15, 0, 100)).toBe(100);
  });

  it('2. roundTo returns 0 on non-finite inputs and rounds accurately', () => {
    expect(roundTo(Number.NaN, 4)).toBe(0);
    expect(roundTo(Number.POSITIVE_INFINITY, 4)).toBe(0);
    expect(roundTo(1.2345678, 4)).toBe(1.2346);
  });

  it('3. mulberry32 produces identical sequence for identical seeds', () => {
    const r1 = mulberry32(9052026);
    const r2 = mulberry32(9052026);
    for (let i = 0; i < 30; i++) {
      expect(r1()).toBe(r2());
    }
  });

  it('4. computeKellyWithFriction matches exact analytical Half-Kelly and haircut', () => {
    const res = computeKellyWithFriction(52, 1.8, 0.08);
    expect(res.fullKellyPct).toBeCloseTo(20.2412, 2);
    expect(res.halfKellyPct).toBeCloseTo(10.1206, 2);
    expect(res.zeroFeeFullKellyPct).toBeGreaterThan(res.fullKellyPct);
    expect(res.kellyHaircutPctPoints).toBeGreaterThan(5);
    expect(res.frictionExceedsReward).toBe(false);
  });

  it('5. computeKellyWithFriction clamps to 0% when friction >= gross reward', () => {
    const res = computeKellyWithFriction(65, 0.4, 0.45);
    expect(res.frictionExceedsReward).toBe(true);
    expect(res.fullKellyPct).toBe(0);
    expect(res.halfKellyPct).toBe(0);
    expect(res.breakevenWinRatePct).toBe(100);
  });

  it('6. computeExecutionBreakeven calculates exact breakeven penalty and impossible target', () => {
    const res = computeExecutionBreakeven({
      stopLossPct: 0.4,
      takeProfitPct: 0.6,
      roundTripCostBps: 14,
    });
    expect(res.nominalBreakevenWinPct).toBeCloseTo(40, 4);
    expect(res.realBreakevenWinPct).toBeCloseTo(54, 4);
    expect(res.winRatePenaltyPct).toBeCloseTo(14, 4);
    expect(res.impossibleTarget).toBe(false);

    const imp = computeExecutionBreakeven({
      stopLossPct: 0.2,
      takeProfitPct: 0.1,
      roundTripCostBps: 12,
    });
    expect(imp.impossibleTarget).toBe(true);
    expect(imp.realBreakevenWinPct).toBe(100);
  });

  it('7. computePositionSizing enforces exact 1R dollar risk including fees', () => {
    const res = computePositionSizing({
      accountBalanceUsd: 10_000,
      riskPct: 1,
      entryPrice: 100_000,
      stopDistancePct: 0.8,
      roundTripCostBps: 10,
    });
    // 0.8% + 0.1% = 0.9% => $100 / 0.009 = $11,111.11
    expect(res.maxRiskUsd).toBe(100);
    expect(res.notionalUsd).toBeCloseTo(11_111.11, 1);
    expect(res.effectiveLeverage).toBeCloseTo(1.1111, 3);
  });

  it('8. computeAbsorbingMarkovStreaks matches exact 64-bit Markov chain probabilities', () => {
    const streaks = computeAbsorbingMarkovStreaks(50, 300, [4, 6, 8, 10, 12]);
    const s8 = streaks.find((s) => s.streak_length === 8)!;
    expect(s8.probability_pct).toBeCloseTo(44.2257, 2);
    for (let i = 1; i < streaks.length; i++) {
      expect(streaks[i]!.probability_pct).toBeLessThanOrEqual(streaks[i - 1]!.probability_pct);
    }
  });

  it('9. walkOrderbookL2 computes exact VWAP and bps slippage on asks and bids', () => {
    const bids = [
      { price: 100, size: 10 }, // $1,000
      { price: 99, size: 20 }, // $1,980
    ];
    const asks = [
      { price: 101, size: 10 }, // $1,010
      { price: 102, size: 20 }, // $2,040
    ];
    const askWalk = walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: 1_520 });
    expect(askWalk.book_side_swept).toBe('asks');
    expect(askWalk.mid_price).toBe(100.5);
    expect(askWalk.levels_consumed).toBe(2);
    expect(askWalk.insufficient_book_depth).toBe(false);
    // $1,010 @ 101 (10 units) + $510 @ 102 (5 units) => 15 units for $1,520 => VWAP = 101.333333
    expect(askWalk.vwap_execution_price).toBeCloseTo(101.333333, 4);

    const bidWalk = walkOrderbookL2({ bids, asks, side: 'sell', orderSizeUsd: 1_495 });
    expect(bidWalk.book_side_swept).toBe('bids');
    // $1,000 @ 100 (10 units) + $495 @ 99 (5 units) => 15 units for $1,495 => VWAP = 99.666667
    expect(bidWalk.vwap_execution_price).toBeCloseTo(99.666667, 4);
  });

  it('10. walkOrderbookL2 rejects NaN, Infinity, zero, and negative orderSizeUsd', () => {
    const bids = [{ price: 100, size: 5 }];
    const asks = [{ price: 101, size: 5 }];
    expect(() => walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: 0 })).toThrow(
      DomainMathError
    );
    expect(() => walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: -500 })).toThrow(
      DomainMathError
    );
    expect(() => walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: Number.NaN })).toThrow(
      DomainMathError
    );
    expect(() =>
      walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: Number.POSITIVE_INFINITY })
    ).toThrow(DomainMathError);
  });

  it('11. walkOrderbookL2 rejects empty books, zero-price levels, and crossed books', () => {
    expect(() => walkOrderbookL2({ bids: [], asks: [], side: 'buy', orderSizeUsd: 100 })).toThrow(
      /zero valid resting/i
    );
    expect(() =>
      walkOrderbookL2({
        bids: [{ price: 0, size: 10 }],
        asks: [{ price: 100, size: 10 }],
        side: 'buy',
        orderSizeUsd: 100,
      })
    ).toThrow(DomainMathError);
    expect(() =>
      walkOrderbookL2({
        bids: [{ price: 105, size: 10 }],
        asks: [{ price: 104, size: 10 }],
        side: 'buy',
        orderSizeUsd: 100,
      })
    ).toThrow(/crossed orderbook/i);
  });

  it('12. walkOrderbookL2 flags insufficient_book_depth without crashing when order exceeds book', () => {
    const bids = [{ price: 99, size: 2 }];
    const asks = [{ price: 100, size: 5 }]; // Only $500 available
    const res = walkOrderbookL2({ bids, asks, side: 'buy', orderSizeUsd: 2_500 });
    expect(res.insufficient_book_depth).toBe(true);
    expect(res.max_available_book_usd).toBe(500);
    expect(res.filled_order_usd).toBe(500);
    expect(res.unfilled_order_usd).toBe(2000);
    expect(res.vwap_execution_price).toBe(100);
  });

  it('13. summarizeOrderbookMicrostructure calculates two-sided depth and $10k/$100k impact', () => {
    const bids = [{ price: 99_990, size: 5 }, { price: 99_900, size: 10 }];
    const asks = [{ price: 100_010, size: 5 }, { price: 100_100, size: 10 }];
    const summary = summarizeOrderbookMicrostructure(bids, asks);
    expect(summary.mid_price).toBe(100_000);
    expect(summary.top_spread_bps).toBeCloseTo(2, 3);
    expect(summary.impact_100k_bps).toBeGreaterThanOrEqual(summary.impact_10k_bps);
  });

  it('14. computeWilderAtr computes 14-period Wilder ATR and 1.5x/2.0x/3.0x 1R sizes', () => {
    const candles = makeSyntheticCandles(40);
    const atr = computeWilderAtr({
      candles,
      period: 14,
      accountEquityUsd: 25_000,
      riskPerTradePct: 1,
      roundTripCostBps: 8,
    });
    expect(atr.atr_value).toBeGreaterThan(0);
    expect(atr.volatility_stops).toHaveLength(3);
    expect(atr.volatility_stops[0]!.one_r_position_notional_usd).toBeGreaterThan(0);
  });

  it('15. computeWilderAtr rejects single-candle or insufficient (<15) candle input', () => {
    const single = makeSyntheticCandles(1);
    expect(() => computeWilderAtr({ candles: single, period: 14 })).toThrow(/At least 15/i);
  });

  it('16. buildIndicatorMatrixFromCandles aligns 8 technical indicators with zero NaNs', () => {
    const candles = makeSyntheticCandles(140);
    const matrix = buildIndicatorMatrixFromCandles(candles, [
      'sma_5',
      'sma_20',
      'ema_12',
      'rsi_14',
      'bb_upper',
      'bb_lower',
      'atr_14',
      'volume_zscore',
    ]);
    const keys = Object.keys(matrix);
    expect(keys).toHaveLength(8);
    const len = matrix.sma_5!.length;
    expect(len).toBeGreaterThanOrEqual(20);
    for (const k of keys) {
      expect(matrix[k]!).toHaveLength(len);
      expect(matrix[k]!.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('17. buildIndicatorMatrixFromCandles rejects insufficient candle history (<75)', () => {
    const shortCandles = makeSyntheticCandles(20);
    expect(() =>
      buildIndicatorMatrixFromCandles(shortCandles, ['sma_5', 'sma_50'])
    ).toThrow(DomainMathError);
  });

  it('18. auditFeatureCollinearity reports LOW severity and <1e-9 off-diagonal dot on uncorrelated features', () => {
    const rng = mulberry32(777);
    const n = 120;
    const f1 = Array.from({ length: n }, () => rng() * 10);
    const f2 = Array.from({ length: n }, () => rng() * 10);
    const f3 = Array.from({ length: n }, () => rng() * 10);

    const res = auditFeatureCollinearity({ f1, f2, f3 });
    expect(res.collinearity_severity).toBe('LOW');
    expect(res.vif_by_feature.f1).toBeLessThan(1.5);
    expect(res.max_off_diagonal_dot).toBeLessThan(1e-9);
    expect(res.effective_rank).toBeGreaterThan(2.8);
  });

  it('19. auditFeatureCollinearity handles exact linear dependence (collinearity=infinity) without NaN', () => {
    const n = 80;
    const base = Array.from({ length: n }, (_, i) => Math.sin(i * 0.2) * 50 + i);
    const exactDup = base.map((x) => 2.5 * x - 12); // r = 1.000000
    const independent = Array.from({ length: n }, (_, i) => Math.cos(i * 0.73) * 10);

    const res = auditFeatureCollinearity({ base, exactDup, independent });
    expect(res.collinearity_severity).toBe('CRITICAL');
    expect(res.condition_number).toBe(1e12); // Capped cleanly at 10^12
    expect(res.high_correlation_pairs[0]?.correlation).toBeCloseTo(1, 5);
    expect(res.independent_info_retention_pct.exactDup).toBe(0);
    expect(res.max_off_diagonal_dot).toBeLessThan(1e-9);
    expect(Number.isFinite(res.vif_by_feature.base)).toBe(true);
  });

  it('20. auditFeatureCollinearity auto-excludes constant zero-variance columns with warning', () => {
    const n = 50;
    const f1 = Array.from({ length: n }, (_, i) => i * 1.5 + Math.sin(i));
    const flat = new Array<number>(n).fill(42);
    const f2 = Array.from({ length: n }, (_, i) => Math.cos(i * 0.4) * 20);

    const res = auditFeatureCollinearity({ f1, flat, f2 });
    expect(res.constant_columns_excluded).toEqual(['flat']);
    expect(res.active_features).toEqual(['f1', 'f2']);
    expect(res.independent_info_retention_pct.flat).toBe(0);
    expect(res.warnings.some((w) => w.includes('flat'))).toBe(true);
    expect(res.max_off_diagonal_dot).toBeLessThan(1e-9);
  });

  it('21. auditFeatureCollinearity handles 2-column matrix where 1 column is constant gracefully', () => {
    const n = 30;
    const f1 = Array.from({ length: n }, (_, i) => i + 1);
    const flat = new Array<number>(n).fill(0);
    const res = auditFeatureCollinearity({ f1, flat });
    expect(res.constant_columns_excluded).toEqual(['flat']);
    expect(res.condition_number).toBe(1);
    expect(res.max_off_diagonal_dot).toBe(0);
  });

  it('22. auditFeatureCollinearity rejects all-constant matrix, mismatched lengths, and NaN values', () => {
    const flatA = new Array<number>(25).fill(1);
    const flatB = new Array<number>(25).fill(2);
    expect(() => auditFeatureCollinearity({ flatA, flatB })).toThrow(/zero variance/i);

    expect(() =>
      auditFeatureCollinearity({
        a: new Array<number>(25).fill(1).map((_, i) => i),
        b: new Array<number>(24).fill(1).map((_, i) => i),
      })
    ).toThrow(/length/i);

    const withNan = new Array<number>(25).fill(1).map((_, i) => i);
    withNan[5] = Number.NaN;
    expect(() =>
      auditFeatureCollinearity({
        a: new Array<number>(25).fill(1).map((_, i) => i * 2),
        b: withNan,
      })
    ).toThrow(/non-finite/i);
  });

  it('23. simulateBacktestReality5000 is deterministic and quantifies friction decay & ruin surge', () => {
    const runA = simulateBacktestReality5000({
      winRatePct: 52,
      avgWinPct: 0.6,
      avgLossPct: 0.4,
      numTrades: 200,
      riskPerTradePct: 2,
      roundTripCostBps: 12,
      ruinDrawdownPct: 30,
      seed: 9052026,
    });
    const runB = simulateBacktestReality5000({
      winRatePct: 52,
      avgWinPct: 0.6,
      avgLossPct: 0.4,
      numTrades: 200,
      riskPerTradePct: 2,
      roundTripCostBps: 12,
      ruinDrawdownPct: 30,
      seed: 9052026,
    });

    expect(runA).toEqual(runB);
    expect(runA.paths_simulated).toBe(5000);
    expect(runA.net_terminal_multiple.median).toBeLessThan(runA.gross_terminal_multiple.median);
    expect(runA.net_ruin_probability_pct).toBeGreaterThanOrEqual(runA.gross_ruin_probability_pct);
    expect(runA.markov_losing_streak_probabilities).toHaveLength(5);
  });

  it('24. Performance SLA: Collinearity (12x500) and 5,000-path Monte Carlo (300 trades) each complete in <50ms', () => {
    const rng = mulberry32(12345);
    const matrix: Record<string, number[]> = {};
    for (let k = 0; k < 12; k++) {
      matrix[`ind_${k}`] = Array.from({ length: 500 }, (_, t) => Math.sin(t * 0.05 * (k + 1)) + rng());
    }

    const t0 = performance.now();
    const colRes = auditFeatureCollinearity(matrix);
    const colMs = performance.now() - t0;
    expect(colRes.max_off_diagonal_dot).toBeLessThan(1e-9);
    expect(colMs).toBeLessThan(50);

    const t1 = performance.now();
    const mcRes = simulateBacktestReality5000({
      winRatePct: 50,
      avgWinPct: 1.0,
      avgLossPct: 0.7,
      numTrades: 300,
      riskPerTradePct: 1.5,
      roundTripCostBps: 10,
    });
    const mcMs = performance.now() - t1;
    expect(mcRes.paths_simulated).toBe(5000);
    expect(mcMs).toBeLessThan(50);
  });
});
