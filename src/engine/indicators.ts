import { DomainMathError, roundTo } from './quantEngine.js';
import type { SupportedIndicatorName } from '../types/schemas.js';

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AtrStopBand {
  multiplier: number;
  stop_distance_price: number;
  stop_distance_pct: number;
  one_r_position_notional_usd: number | null;
  one_r_position_units: number | null;
}

export interface WilderAtrResult {
  period: number;
  latest_close: number;
  atr_value: number;
  atr_pct_of_close: number;
  volatility_stops: AtrStopBand[];
}

/**
 * Track B Extension 2: 14-Period Wilder ATR & Dynamic Volatility Stop-Loss Sizer
 */
export function computeWilderAtr(params: {
  candles: OhlcvCandle[];
  period?: number;
  accountEquityUsd?: number;
  riskPerTradePct?: number;
  roundTripCostBps?: number;
}): WilderAtrResult {
  const period = Math.max(2, Math.round(params.period ?? 14));
  const clean = params.candles
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.close > 0 &&
        c.high >= c.low &&
        c.low > 0
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (clean.length < period + 1) {
    throw new DomainMathError(
      'INSUFFICIENT_CANDLES',
      `At least ${period + 1} valid OHLCV candles are required for ${period}-period Wilder ATR (received ${clean.length}).`
    );
  }

  const trs = new Float64Array(clean.length - 1);
  for (let i = 1; i < clean.length; i++) {
    const cur = clean[i]!;
    const prevClose = clean[i - 1]!.close;
    const hl = cur.high - cur.low;
    const hc = Math.abs(cur.high - prevClose);
    const lc = Math.abs(cur.low - prevClose);
    trs[i - 1] = Math.max(hl, hc, lc);
  }

  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trs[i]!;
  }
  atr /= period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }

  const latestClose = clean[clean.length - 1]!.close;
  const atrPct = (atr / latestClose) * 100;

  const hasAccount =
    typeof params.accountEquityUsd === 'number' &&
    Number.isFinite(params.accountEquityUsd) &&
    params.accountEquityUsd > 0;
  const riskFrac = Math.max(0.0001, (params.riskPerTradePct ?? 1.0) / 100);
  const feeFrac = Math.max(0, (params.roundTripCostBps ?? 0) / 10_000);

  const multipliers = [1.5, 2.0, 3.0];
  const stops: AtrStopBand[] = multipliers.map((mult) => {
    const distPrice = atr * mult;
    const distPct = (distPrice / latestClose) * 100;
    const distFrac = distPct / 100;
    let notionalUsd: number | null = null;
    let units: number | null = null;

    if (hasAccount && distFrac + feeFrac > 0) {
      const riskUsd = params.accountEquityUsd! * riskFrac;
      notionalUsd = roundTo(riskUsd / (distFrac + feeFrac), 2);
      units = roundTo(notionalUsd / latestClose, 6);
    }

    return {
      multiplier: mult,
      stop_distance_price: roundTo(distPrice, 6),
      stop_distance_pct: roundTo(distPct, 4),
      one_r_position_notional_usd: notionalUsd,
      one_r_position_units: units,
    };
  });

  return {
    period,
    latest_close: roundTo(latestClose, 6),
    atr_value: roundTo(atr, 6),
    atr_pct_of_close: roundTo(atrPct, 4),
    volatility_stops: stops,
  };
}

function calcSma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function calcEma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let ema = seed / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRsi(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function calcBollinger(closes: number[], period = 20, numStd = 2) {
  const mid = calcSma(closes, period);
  const upper = new Array<number>(closes.length).fill(Number.NaN);
  const lower = new Array<number>(closes.length).fill(Number.NaN);
  const width = new Array<number>(closes.length).fill(Number.NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i]!;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j]! - m;
      sq += d * d;
    }
    const std = Math.sqrt(sq / period);
    upper[i] = m + numStd * std;
    lower[i] = m - numStd * std;
    width[i] = m > 0 ? ((upper[i]! - lower[i]!) / m) * 100 : 0;
  }
  return { mid, upper, lower, width };
}

function calcAtrSeries(candles: OhlcvCandle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(Number.NaN);
  if (candles.length <= period) return out;

  const tr = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = candles[i - 1]!.close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i]!;
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

function calcRollingZScore(values: number[], period = 20): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j]! - mean;
      sq += d * d;
    }
    const std = Math.sqrt(sq / period);
    out[i] = std > 1e-12 ? (values[i]! - mean) / std : 0;
  }
  return out;
}

function calcRoc(closes: number[], period = 10): number[] {
  const out = new Array<number>(closes.length).fill(Number.NaN);
  for (let i = period; i < closes.length; i++) {
    const prev = closes[i - period]!;
    out[i] = prev > 0 ? ((closes[i]! - prev) / prev) * 100 : 0;
  }
  return out;
}

/**
 * Builds an aligned feature matrix from OHLCV candles for Mode A of `audit_indicator_collinearity`.
 */
export function buildIndicatorMatrixFromCandles(
  candles: OhlcvCandle[],
  indicators: SupportedIndicatorName[]
): Record<string, number[]> {
  const clean = candles
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.volume) &&
        c.close > 0 &&
        c.high >= c.low
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (clean.length < 75) {
    throw new DomainMathError(
      'INSUFFICIENT_CANDLES',
      `At least 75 valid OHLCV candles are required to align indicator warm-up windows (received ${clean.length}).`
    );
  }

  const closes = clean.map((c) => c.close);
  const volumes = clean.map((c) => c.volume);
  const bb = calcBollinger(closes, 20, 2);
  const ema12 = calcEma(closes, 12);
  const ema26 = calcEma(closes, 26);

  const rawMap: Record<string, number[]> = {};
  for (const name of indicators) {
    switch (name) {
      case 'sma_5':
        rawMap[name] = calcSma(closes, 5);
        break;
      case 'sma_20':
        rawMap[name] = calcSma(closes, 20);
        break;
      case 'sma_50':
        rawMap[name] = calcSma(closes, 50);
        break;
      case 'ema_12':
        rawMap[name] = ema12;
        break;
      case 'ema_26':
        rawMap[name] = ema26;
        break;
      case 'rsi_14':
        rawMap[name] = calcRsi(closes, 14);
        break;
      case 'bb_upper':
        rawMap[name] = bb.upper;
        break;
      case 'bb_lower':
        rawMap[name] = bb.lower;
        break;
      case 'bb_middle':
        rawMap[name] = bb.mid;
        break;
      case 'bb_width':
        rawMap[name] = bb.width;
        break;
      case 'atr_14':
        rawMap[name] = calcAtrSeries(clean, 14);
        break;
      case 'volume_zscore':
        rawMap[name] = calcRollingZScore(volumes, 20);
        break;
      case 'roc_10':
        rawMap[name] = calcRoc(closes, 10);
        break;
      case 'macd_line':
        rawMap[name] = closes.map((_, idx) =>
          Number.isFinite(ema12[idx]) && Number.isFinite(ema26[idx])
            ? ema12[idx]! - ema26[idx]!
            : Number.NaN
        );
        break;
    }
  }

  // Find common valid start index across all requested indicators
  let startIdx = 0;
  for (let i = 0; i < clean.length; i++) {
    const allFinite = indicators.every((ind) => Number.isFinite(rawMap[ind]?.[i]));
    if (allFinite) {
      startIdx = i;
      break;
    }
    if (i === clean.length - 1) {
      throw new DomainMathError(
        'ALIGNMENT_FAILED',
        'Could not align at least 20 finite indicator observations.'
      );
    }
  }

  const alignedCount = clean.length - startIdx;
  if (alignedCount < 20) {
    throw new DomainMathError(
      'INSUFFICIENT_OBSERVATIONS',
      `Aligned indicator matrix has only ${alignedCount} rows; minimum 20 required.`
    );
  }

  const out: Record<string, number[]> = {};
  for (const name of indicators) {
    out[name] = rawMap[name]!.slice(startIdx);
  }
  return out;
}

/**
 * Gauss-Jordan Matrix Inversion with Partial Row Pivoting on a square p x p matrix.
 */
function invertMatrixGaussJordan(mat: number[][]): number[][] {
  const n = mat.length;
  const aug: number[][] = mat.map((row, i) => {
    const idRow = new Array<number>(n).fill(0);
    idRow[i] = 1;
    return [...row, ...idRow];
  });

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(aug[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const cand = Math.abs(aug[r]![col]!);
      if (cand > maxAbs) {
        maxAbs = cand;
        pivotRow = r;
      }
    }

    if (pivotRow !== col) {
      const tmp = aug[col]!;
      aug[col] = aug[pivotRow]!;
      aug[pivotRow] = tmp;
    }

    const pivotVal = aug[col]![col]!;
    const safePivot = Math.abs(pivotVal) < 1e-14 ? (pivotVal >= 0 ? 1e-14 : -1e-14) : pivotVal;
    for (let j = 0; j < 2 * n; j++) {
      aug[col]![j] = aug[col]![j]! / safePivot;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        aug[r]![j] = aug[r]![j]! - factor * aug[col]![j]!;
      }
    }
  }

  return aug.map((row) => row.slice(n, 2 * n));
}

/**
 * Cyclic Jacobi Eigenvalue Solver for Real Symmetric Matrices (p <= 15).
 * Converges to machine precision (~1e-14) in < 0.5 ms.
 */
function symmetricEigenvaluesJacobi(symMat: number[][], maxSweeps = 80): number[] {
  const n = symMat.length;
  if (n === 1) return [symMat[0]![0]!];

  const A: number[][] = symMat.map((r) => [...r]);

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let maxOffDiag = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const aPQ = A[p]![q]!;
        if (Math.abs(aPQ) > maxOffDiag) maxOffDiag = Math.abs(aPQ);
      }
    }
    if (maxOffDiag < 1e-14) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const aPQ = A[p]![q]!;
        if (Math.abs(aPQ) < 1e-15) continue;

        const aPP = A[p]![p]!;
        const aQQ = A[q]![q]!;
        const tau = (aQQ - aPP) / (2 * aPQ);
        const t =
          tau >= 0
            ? 1 / (tau + Math.sqrt(1 + tau * tau))
            : -1 / (-tau + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        A[p]![p] = aPP - t * aPQ;
        A[q]![q] = aQQ + t * aPQ;
        A[p]![q] = 0;
        A[q]![p] = 0;

        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const aKP = A[k]![p]!;
          const aKQ = A[k]![q]!;
          A[k]![p] = c * aKP - s * aKQ;
          A[p]![k] = A[k]![p]!;
          A[k]![q] = s * aKP + c * aKQ;
          A[q]![k] = A[k]![q]!;
        }
      }
    }
  }

  return A.map((row, idx) => Math.max(0, row[idx]!)).sort((a, b) => b - a);
}

export interface RedundantPair {
  feature_a: string;
  feature_b: string;
  correlation: number;
}

export interface CollinearityAuditResult {
  observations_analyzed: number;
  active_features: string[];
  constant_columns_excluded: string[];
  vif_by_feature: Record<string, number>;
  high_correlation_pairs: RedundantPair[];
  condition_number: number;
  effective_rank: number;
  collinearity_severity: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  independent_info_retention_pct: Record<string, number>;
  orthogonal_weights: Record<string, number>;
  max_off_diagonal_dot: number;
  warnings: string[];
}

/**
 * Track B Extension 3: Collinearity, Ridge-Regularized VIF, Condition Number &
 * 2-Pass Modified Gram-Schmidt Orthogonalizer.
 */
export function auditFeatureCollinearity(
  featureMatrix: Record<string, number[]>
): CollinearityAuditResult {
  const rawNames = Object.keys(featureMatrix);
  if (rawNames.length < 2 || rawNames.length > 15) {
    throw new DomainMathError(
      'INVALID_FEATURE_COUNT',
      `Expected between 2 and 15 features, received ${rawNames.length}.`
    );
  }

  const nObs = featureMatrix[rawNames[0]!]!.length;
  if (nObs < 20 || nObs > 2000) {
    throw new DomainMathError(
      'INVALID_OBSERVATION_COUNT',
      `Expected between 20 and 2,000 observations per feature, received ${nObs}.`
    );
  }

  for (const name of rawNames) {
    const arr = featureMatrix[name]!;
    if (arr.length !== nObs) {
      throw new DomainMathError(
        'MISMATCHED_SERIES_LENGTH',
        `Feature "${name}" has length ${arr.length}, expected ${nObs}.`
      );
    }
    for (let i = 0; i < nObs; i++) {
      if (!Number.isFinite(arr[i])) {
        throw new DomainMathError(
          'NON_FINITE_FEATURE_VALUE',
          `Feature "${name}" contains non-finite value at index ${i}.`
        );
      }
    }
  }

  const warnings: string[] = [];
  const constantColumnsExcluded: string[] = [];
  const activeFeatures: string[] = [];
  const zColumns: Float64Array[] = [];

  for (const name of rawNames) {
    const arr = featureMatrix[name]!;
    let sum = 0;
    for (let i = 0; i < nObs; i++) sum += arr[i]!;
    const mean = sum / nObs;

    let sq = 0;
    for (let i = 0; i < nObs; i++) {
      const d = arr[i]! - mean;
      sq += d * d;
    }
    const sampleStd = Math.sqrt(sq / (nObs - 1));

    if (sampleStd < 1e-12) {
      constantColumnsExcluded.push(name);
      warnings.push(
        `Constant or zero-variance feature "${name}" (std < 1e-12) automatically excluded prior to Z-score standardization.`
      );
      continue;
    }

    const z = new Float64Array(nObs);
    for (let i = 0; i < nObs; i++) {
      z[i] = (arr[i]! - mean) / sampleStd;
    }
    activeFeatures.push(name);
    zColumns.push(z);
  }

  if (activeFeatures.length === 0) {
    throw new DomainMathError(
      'ALL_COLUMNS_CONSTANT',
      'All supplied indicator columns have zero variance; collinearity audit cannot proceed.'
    );
  }

  // Degenerate single active feature case (when all other columns were constant)
  if (activeFeatures.length === 1) {
    const sole = activeFeatures[0]!;
    const retention: Record<string, number> = { [sole]: 100 };
    const weights: Record<string, number> = { [sole]: 1 };
    for (const c of constantColumnsExcluded) {
      retention[c] = 0;
      weights[c] = 0;
    }
    return {
      observations_analyzed: nObs,
      active_features: activeFeatures,
      constant_columns_excluded: constantColumnsExcluded,
      vif_by_feature: { [sole]: 1 },
      high_correlation_pairs: [],
      condition_number: 1,
      effective_rank: 1,
      collinearity_severity: 'LOW',
      independent_info_retention_pct: retention,
      orthogonal_weights: weights,
      max_off_diagonal_dot: 0,
      warnings,
    };
  }

  const p = activeFeatures.length;
  const R: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const highCorrPairs: RedundantPair[] = [];

  for (let i = 0; i < p; i++) {
    R[i]![i] = 1;
    for (let j = i + 1; j < p; j++) {
      let dot = 0;
      const zi = zColumns[i]!;
      const zj = zColumns[j]!;
      for (let t = 0; t < nObs; t++) dot += zi[t]! * zj[t]!;
      const corr = Math.max(-1, Math.min(1, dot / (nObs - 1)));
      R[i]![j] = corr;
      R[j]![i] = corr;
      if (Math.abs(corr) > 0.85) {
        highCorrPairs.push({
          feature_a: activeFeatures[i]!,
          feature_b: activeFeatures[j]!,
          correlation: roundTo(corr, 6),
        });
      }
    }
  }
  highCorrPairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  // Ridge regularization (R + eps * I, eps = 1e-10) for guaranteed invertibility under exact collinearity
  const eps = 1e-10;
  const ridgeR = R.map((row, idx) => row.map((v, colIdx) => (idx === colIdx ? v + eps : v)));
  const invR = invertMatrixGaussJordan(ridgeR);

  const vifByFeature: Record<string, number> = {};
  let maxVif = 1;
  for (let i = 0; i < p; i++) {
    const rawVif = Math.min(1e10, Math.max(1, invR[i]![i]!));
    vifByFeature[activeFeatures[i]!] = roundTo(rawVif, 4);
    if (rawVif > maxVif) maxVif = rawVif;
  }

  // Eigenvalues, Condition Number (capped at 1e12), and Shannon Effective Rank
  const eigenvalues = symmetricEigenvaluesJacobi(R);
  const lambdaMax = Math.max(1e-12, eigenvalues[0] ?? 1);
  const lambdaMin = Math.max(0, eigenvalues[eigenvalues.length - 1] ?? 0);
  const rawCond = lambdaMin <= 1e-12 ? 1e12 : Math.min(1e12, lambdaMax / lambdaMin);

  const eigSum = eigenvalues.reduce((acc, v) => acc + v, 0);
  let entropy = 0;
  if (eigSum > 0) {
    for (const lam of eigenvalues) {
      const prob = lam / eigSum;
      if (prob > 1e-15) entropy -= prob * Math.log(prob);
    }
  }
  const effectiveRank = Math.min(p, Math.max(1, Math.exp(entropy)));

  // 2-Pass Modified Gram-Schmidt ("Twice is Enough" Kahan Re-Orthogonalization)
  const unitScale = 1 / Math.sqrt(nObs - 1);
  const orthonormalBasis: Float64Array[] = [];
  const retentionPctMap: Record<string, number> = {};
  const residualNorms = new Float64Array(p);

  for (let j = 0; j < p; j++) {
    const v = new Float64Array(nObs);
    const zj = zColumns[j]!;
    for (let t = 0; t < nObs; t++) v[t] = zj[t]! * unitScale; // ||u_j||_2 === 1

    // Pass 1: Modified Gram-Schmidt projection
    for (const qVec of orthonormalBasis) {
      let dot = 0;
      for (let t = 0; t < nObs; t++) dot += qVec[t]! * v[t]!;
      for (let t = 0; t < nObs; t++) v[t] = v[t]! - dot * qVec[t]!;
    }

    let pass1NormSq = 0;
    for (let t = 0; t < nObs; t++) pass1NormSq += v[t]! * v[t]!;
    const clampedNormSq = Math.min(1, Math.max(0, pass1NormSq));

    // Pass 2: Re-orthogonalization to drive off-diagonal inner products < 1e-14
    for (const qVec of orthonormalBasis) {
      let dot = 0;
      for (let t = 0; t < nObs; t++) dot += qVec[t]! * v[t]!;
      for (let t = 0; t < nObs; t++) v[t] = v[t]! - dot * qVec[t]!;
    }

    let finalNormSq = 0;
    for (let t = 0; t < nObs; t++) finalNormSq += v[t]! * v[t]!;
    const finalNorm = Math.sqrt(finalNormSq);

    const featName = activeFeatures[j]!;
    if (finalNorm > 1e-8) {
      const invNorm = 1 / finalNorm;
      for (let t = 0; t < nObs; t++) v[t] = v[t]! * invNorm;
      orthonormalBasis.push(v);
      retentionPctMap[featName] = roundTo(clampedNormSq * 100, 4);
      residualNorms[j] = Math.sqrt(clampedNormSq);
    } else {
      retentionPctMap[featName] = 0;
      residualNorms[j] = 0;
      warnings.push(
        `Feature "${featName}" is numerically linearly dependent on preceding indicators (residual norm < 1e-8).`
      );
    }
  }

  for (const c of constantColumnsExcluded) {
    retentionPctMap[c] = 0;
  }

  // Orthogonal de-duplicated weights proportional to independent residual norms
  let normSum = 0;
  for (let j = 0; j < p; j++) normSum += residualNorms[j]!;
  const orthogonalWeights: Record<string, number> = {};
  for (let j = 0; j < p; j++) {
    const featName = activeFeatures[j]!;
    orthogonalWeights[featName] =
      normSum > 0 ? roundTo(residualNorms[j]! / normSum, 6) : roundTo(1 / p, 6);
  }
  for (const c of constantColumnsExcluded) {
    orthogonalWeights[c] = 0;
  }

  // Verify orthonormality error: max_{a != b} |<q_a, q_b>|
  let maxOffDiagonalDot = 0;
  for (let a = 0; a < orthonormalBasis.length; a++) {
    for (let b = a + 1; b < orthonormalBasis.length; b++) {
      let dot = 0;
      const qa = orthonormalBasis[a]!;
      const qb = orthonormalBasis[b]!;
      for (let t = 0; t < nObs; t++) dot += qa[t]! * qb[t]!;
      const absDot = Math.abs(dot);
      if (absDot > maxOffDiagonalDot) maxOffDiagonalDot = absDot;
    }
  }

  let severity: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (maxVif >= 20 || rawCond >= 1000) severity = 'CRITICAL';
  else if (maxVif >= 10 || rawCond >= 100) severity = 'HIGH';
  else if (maxVif >= 5 || rawCond >= 30) severity = 'MODERATE';

  if (severity === 'CRITICAL' || severity === 'HIGH') {
    warnings.push(
      `High indicator collinearity detected (severity=${severity}, max VIF=${roundTo(maxVif, 2)}). Prune redundant pairs or apply orthogonal_weights.`
    );
  }

  return {
    observations_analyzed: nObs,
    active_features: activeFeatures,
    constant_columns_excluded: constantColumnsExcluded,
    vif_by_feature: vifByFeature,
    high_correlation_pairs: highCorrPairs,
    condition_number: roundTo(rawCond, 4),
    effective_rank: roundTo(effectiveRank, 4),
    collinearity_severity: severity,
    independent_info_retention_pct: retentionPctMap,
    orthogonal_weights: orthogonalWeights,
    max_off_diagonal_dot: Number(maxOffDiagonalDot.toExponential(6)),
    warnings,
  };
}
