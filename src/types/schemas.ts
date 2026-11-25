import { z } from 'zod';

/**
 * Mandatory Non-Advisory Regulatory Firewall Metadata (Capital Markets Act Compliance).
 * Included at the top of every successful analytical response.
 */
export const NON_ADVISORY_DISCLAIMER =
  'Deterministic mathematical calculation for educational and risk-simulation purposes only. Not financial or investment advice.' as const;

export const NonAdvisoryMetaSchema = z.object({
  advisory: z.literal(false),
  data_type: z.literal('derived_quantitative_analytics'),
  disclaimer: z.literal(NON_ADVISORY_DISCLAIMER),
});

export type NonAdvisoryMeta = z.infer<typeof NonAdvisoryMetaSchema>;

export function createNonAdvisoryMeta(): NonAdvisoryMeta {
  return {
    advisory: false,
    data_type: 'derived_quantitative_analytics',
    disclaimer: NON_ADVISORY_DISCLAIMER,
  };
}

/**
 * Tool 1 Input Schema: preflight_execution_risk
 */
export const PreflightExecutionInputShape = {
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .describe(
      'Underlying perpetual asset ticker (e.g., "BTC", "ETH", "SOL", "BTCUSDT", "kPEPE"). Automatically normalized across venues.'
    ),
  order_size_usd: z
    .number()
    .finite()
    .min(10)
    .max(50_000_000)
    .describe('Target market order notional size in USD (10 to 50,000,000).'),
  side: z
    .enum(['buy', 'sell'])
    .describe('Order execution direction: "buy" walks resting ask liquidity; "sell" walks resting bid liquidity.'),
  venue: z
    .enum(['hyperliquid', 'okx', 'auto'])
    .default('auto')
    .describe('Target market data venue. Use "auto" (default) for Hyperliquid primary with automatic OKX Swap failover.'),
  account_equity_usd: z
    .number()
    .finite()
    .min(10)
    .max(1_000_000_000)
    .optional()
    .describe('Optional total account equity in USD to compute 1R ATR-based position sizing.'),
  taker_fee_bps: z
    .number()
    .finite()
    .min(0)
    .max(200)
    .default(3.5)
    .describe('Single-leg exchange taker commission in basis points (1 bps = 0.01%). Default: 3.5 bps.'),
  win_rate_pct: z
    .number()
    .finite()
    .min(1)
    .max(99)
    .optional()
    .describe('Optional historical strategy win rate percentage (1..99) to unlock Half-Kelly and Quarter-Kelly risk sizing.'),
  reward_risk_ratio: z
    .number()
    .finite()
    .min(0.1)
    .max(50)
    .optional()
    .describe('Optional gross reward-to-risk ratio before friction (e.g., 1.8) used alongside win_rate_pct for Kelly sizing.'),
  holding_hours: z
    .number()
    .finite()
    .min(0)
    .max(720)
    .default(1)
    .describe('Planned trade holding duration in hours (0 to 720) for cumulative funding drag estimation. Default: 1 hour.'),
};

export const PreflightExecutionInputSchema = z.object(PreflightExecutionInputShape);
export type PreflightExecutionInput = z.infer<typeof PreflightExecutionInputSchema>;

/**
 * Tool 2 Input Schema: scan_venue_microstructure
 */
export const ScanVenueMicrostructureInputShape = {
  symbols: z
    .array(z.string().trim().min(1).max(30))
    .min(1)
    .max(20)
    .optional()
    .describe('Optional list of up to 20 perpetual tickers (e.g., ["BTC","ETH","SOL"]). Omit to scan top liquid pairs automatically.'),
  min_open_interest_usd: z
    .number()
    .finite()
    .min(0)
    .max(10_000_000_000)
    .default(1_000_000)
    .describe('Minimum open interest filter in USD. Default: 1,000,000.'),
  sort_by: z
    .enum(['abs_funding_apr', 'open_interest_usd', 'spread_bps'])
    .default('open_interest_usd')
    .describe('Sorting metric for returned pairs: "open_interest_usd" (default), "abs_funding_apr", or "spread_bps".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of perpetual pairs to return (1 to 20). Default: 10.'),
};

export const ScanVenueMicrostructureInputSchema = z.object(ScanVenueMicrostructureInputShape);
export type ScanVenueMicrostructureInput = z.infer<typeof ScanVenueMicrostructureInputSchema>;

/**
 * Tool 3 Input Schema: audit_indicator_collinearity
 */
export const SupportedIndicatorEnum = z.enum([
  'sma_5',
  'sma_20',
  'sma_50',
  'ema_12',
  'ema_26',
  'rsi_14',
  'bb_upper',
  'bb_lower',
  'bb_middle',
  'bb_width',
  'atr_14',
  'volume_zscore',
  'roc_10',
  'macd_line',
]);

export type SupportedIndicatorName = z.infer<typeof SupportedIndicatorEnum>;

export const AuditCollinearityInputShape = {
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .optional()
    .describe('Mode A (Live Auto-Fetch): Perpetual ticker (e.g., "BTC") to fetch OHLCV candles and compute technical indicators.'),
  interval: z
    .enum(['15m', '1h', '4h', '1d'])
    .default('1h')
    .describe('Mode A candle timeframe ("15m", "1h", "4h", "1d"). Default: "1h".'),
  indicators: z
    .array(SupportedIndicatorEnum)
    .min(2)
    .max(12)
    .optional()
    .describe(
      'Mode A list of 2 to 12 built-in indicators (e.g., ["sma_5","sma_20","ema_12","rsi_14","bb_upper","atr_14","volume_zscore"]).'
    ),
  feature_matrix: z
    .record(
      z.string().trim().min(1).max(64),
      z.array(z.number().finite()).min(20).max(2000)
    )
    .optional()
    .describe(
      'Mode B (Custom Matrix): Object mapping 2 to 15 indicator names to equal-length numeric arrays (20 to 2,000 observations each). Do not combine with Mode A.'
    ),
};

export const AuditCollinearityInputSchema = z
  .object(AuditCollinearityInputShape)
  .superRefine((val, ctx) => {
    const hasModeA = Boolean(val.symbol && val.indicators && val.indicators.length >= 2);
    const hasModeB = Boolean(val.feature_matrix && Object.keys(val.feature_matrix).length > 0);

    if (hasModeA && hasModeB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either Mode A (symbol + indicators) OR Mode B (feature_matrix), not both simultaneously.',
      });
      return;
    }
    if (!hasModeA && !hasModeB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Must provide either Mode A (symbol + at least 2 indicators) or Mode B (feature_matrix with 2 to 15 equal-length numeric series of 20..2000 observations).',
      });
      return;
    }
    if (val.feature_matrix) {
      const keys = Object.keys(val.feature_matrix);
      if (keys.length < 2 || keys.length > 15) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `feature_matrix must contain between 2 and 15 indicator series (received ${keys.length}).`,
        });
        return;
      }
      const firstLen = val.feature_matrix[keys[0]!]!.length;
      for (const k of keys) {
        const len = val.feature_matrix[k]!.length;
        if (len !== firstLen) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `All series in feature_matrix must have identical length (expected ${firstLen}, "${k}" has ${len}).`,
          });
          return;
        }
      }
    }
  });

export type AuditCollinearityInput = z.infer<typeof AuditCollinearityInputSchema>;

/**
 * Tool 4 Input Schema: simulate_backtest_reality
 */
export const SimulateBacktestRealityInputShape = {
  win_rate_pct: z
    .number()
    .finite()
    .min(1)
    .max(99)
    .describe('Backtest gross win rate percentage (1 to 99).'),
  avg_win_pct: z
    .number()
    .finite()
    .gt(0)
    .max(500)
    .describe('Average winning trade price move percentage before fees (e.g., 0.8 for +0.80%). Must be > 0.'),
  avg_loss_pct: z
    .number()
    .finite()
    .gt(0)
    .max(99)
    .describe('Average losing trade stop-loss distance percentage before fees (e.g., 0.5 for -0.50%). Must be > 0.'),
  num_trades: z
    .number()
    .int()
    .min(10)
    .max(5000)
    .describe('Evaluation horizon in number of sequential trades (10 to 5,000).'),
  risk_per_trade_pct: z
    .number()
    .finite()
    .min(0.1)
    .max(50)
    .describe('Account equity percentage risked per 1R stop-loss trade (0.1 to 50).'),
  round_trip_cost_bps: z
    .number()
    .finite()
    .min(0)
    .max(500)
    .default(10)
    .describe(
      'Total round-trip fee + slippage cost in basis points (0 to 500). Ignored only when symbol + order_size_usd are supplied to inject live L2 slippage.'
    ),
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .optional()
    .describe('Optional perpetual symbol (e.g., "BTC") to measure live L2 slippage and inject into round-trip cost.'),
  order_size_usd: z
    .number()
    .finite()
    .min(10)
    .max(50_000_000)
    .optional()
    .describe('Optional order notional USD (used with symbol) to book-walk live L2 slippage for friction injection.'),
  taker_fee_bps: z
    .number()
    .finite()
    .min(0)
    .max(200)
    .default(3.5)
    .describe('Single-leg taker fee in bps when live L2 slippage injection (symbol + order_size_usd) is used. Default: 3.5 bps.'),
  ruin_drawdown_pct: z
    .number()
    .finite()
    .min(5)
    .max(95)
    .default(30)
    .describe('Terminal drawdown threshold percentage defining account ruin (5 to 95). Default: 30%.'),
  seed: z
    .number()
    .int()
    .default(9052026)
    .describe('Deterministic 32-bit PRNG seed for 5,000-path Mulberry32 Monte Carlo simulation. Default: 9052026.'),
};

export const SimulateBacktestRealityInputSchema = z.object(SimulateBacktestRealityInputShape);
export type SimulateBacktestRealityInput = z.infer<typeof SimulateBacktestRealityInputSchema>;

/**
 * Output Validation & Non-Advisory Regulatory Firewall Gate.
 * Verifies:
 * 1. Top-level `meta` matches NonAdvisoryMetaSchema (`advisory === false`).
 * 2. Zero NaN, Infinity, or non-finite numbers anywhere in nested payload.
 * 3. Zero directional trading recommendation tokens (BUY / SELL / HOLD / LONG / SHORT).
 */
const PROHIBITED_ADVISORY_TOKEN_REGEX = /\b(BUY|SELL|HOLD|LONG|SHORT)\b/i;

export function validateAndVerifyNonAdvisoryOutput<T extends Record<string, unknown>>(payload: T): T {
  const metaResult = NonAdvisoryMetaSchema.safeParse(payload.meta);
  if (!metaResult.success) {
    throw new Error('Regulatory firewall violation: missing or invalid top-level non-advisory meta block.');
  }

  const keys = Object.keys(payload);
  if (keys[0] !== 'meta') {
    throw new Error('Regulatory firewall violation: "meta" must be the first top-level key in response JSON.');
  }

  function inspectNode(node: unknown, path: string): void {
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        throw new Error(`Numerical integrity violation: non-finite number (${String(node)}) at ${path}`);
      }
      return;
    }
    if (typeof node === 'string') {
      if (path !== 'root.meta.disclaimer' && PROHIBITED_ADVISORY_TOKEN_REGEX.test(node)) {
        throw new Error(`Regulatory firewall violation: prohibited directional token in string at ${path}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        inspectNode(node[i], `${path}[${i}]`);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (PROHIBITED_ADVISORY_TOKEN_REGEX.test(k)) {
          throw new Error(`Regulatory firewall violation: prohibited directional token in key "${k}" at ${path}`);
        }
        inspectNode(v, `${path}.${k}`);
      }
    }
  }

  inspectNode(payload, 'root');
  return payload;
}
