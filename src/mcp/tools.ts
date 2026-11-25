import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodError } from 'zod';
import { UpstreamError } from '../adapters/cacheAndBreaker.js';
import { VenueRouter, normalizeSymbol } from '../adapters/venueRouter.js';
import { BillingGate, type PpeEventName } from '../billing/billingGate.js';
import {
  auditFeatureCollinearity,
  buildIndicatorMatrixFromCandles,
  computeWilderAtr,
} from '../engine/indicators.js';
import {
  DomainMathError,
  computeExecutionBreakeven,
  computeKellyWithFriction,
  roundTo,
  simulateBacktestReality5000,
  summarizeOrderbookMicrostructure,
  walkOrderbookL2,
} from '../engine/quantEngine.js';
import {
  AuditCollinearityInputSchema,
  AuditCollinearityInputShape,
  PreflightExecutionInputSchema,
  PreflightExecutionInputShape,
  ScanVenueMicrostructureInputSchema,
  ScanVenueMicrostructureInputShape,
  SimulateBacktestRealityInputSchema,
  SimulateBacktestRealityInputShape,
  createNonAdvisoryMeta,
} from '../types/schemas.js';

export const FROZEN_TOOL_NAMES = [
  'preflight_execution_risk',
  'scan_venue_microstructure',
  'audit_indicator_collinearity',
  'simulate_backtest_reality',
] as const;

export type FrozenToolName = (typeof FROZEN_TOOL_NAMES)[number];

export interface ToolRuntimeDependencies {
  router: VenueRouter;
  billing: BillingGate;
}

export interface McpToolExecutionResponse {
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

function formatMcpError(err: unknown): McpToolExecutionResponse {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: 'INVALID_INPUT',
                message: 'Tool input validation failed. Zero fee charged.',
                details,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (err instanceof DomainMathError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: err.code,
                message: `${err.message} Zero fee charged.`,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (err instanceof UpstreamError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: err.code,
                message: `${err.message} Zero fee charged.`,
                retryable: err.retryable,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code: 'INTERNAL_EXECUTION_ERROR',
              message:
                err instanceof Error
                  ? `Execution aborted safely (${err.message}). Zero fee charged.`
                  : 'Execution aborted safely. Zero fee charged.',
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

async function runWithFailClosedBilling<T extends Record<string, unknown>>(
  eventName: PpeEventName,
  billing: BillingGate,
  computeFn: () => Promise<T>
): Promise<McpToolExecutionResponse> {
  try {
    const computedPayload = await computeFn();
    const outcome = await billing.verifyAndCharge(eventName, computedPayload);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(outcome.payload, null, 2),
        },
      ],
    };
  } catch (err) {
    // Fail-Closed Guarantee: Actor.charge() is never reached when computeFn or schema validation throws.
    return formatMcpError(err);
  }
}

/**
 * Tool 1 Handler: preflight_execution_risk ($0.008)
 */
export async function handlePreflightExecutionRisk(
  rawArgs: unknown,
  deps: ToolRuntimeDependencies
): Promise<McpToolExecutionResponse> {
  return runWithFailClosedBilling('preflight-execution-risk', deps.billing, async () => {
    const input = PreflightExecutionInputSchema.parse(rawArgs);
    const canonicalSymbol = normalizeSymbol(input.symbol, 'canonical');

    const [bookRouted, candlesRouted] = await Promise.all([
      deps.router.getOrderbook(input.symbol, input.venue),
      deps.router.getCandles(input.symbol, '1h', 60, input.venue),
    ]);

    const warnings: string[] = [
      ...bookRouted.warnings,
      ...candlesRouted.warnings.filter((w) => !bookRouted.warnings.includes(w)),
    ];

    // Fetch funding context (non-fatal fallback to 0 with warning if context endpoint fails)
    let fundingRate1hPct = 0;
    try {
      const ctxRouted = await deps.router.getMarketContexts([input.symbol], input.venue);
      const match = ctxRouted.data.find(
        (item) => normalizeSymbol(item.symbol, 'canonical') === canonicalSymbol
      );
      if (match) {
        fundingRate1hPct = match.fundingRate1hPct;
      }
    } catch {
      warnings.push('Live funding context unavailable; funding drag defaulted to 0 bps.');
    }

    const walk = walkOrderbookL2({
      bids: bookRouted.data.bids,
      asks: bookRouted.data.asks,
      side: input.side,
      orderSizeUsd: input.order_size_usd,
    });

    if (walk.insufficient_book_depth) {
      warnings.push(
        `INSUFFICIENT_BOOK_DEPTH: Visible L2 depth ($${walk.max_available_book_usd}) is smaller than requested order_size_usd ($${walk.requested_order_usd}). VWAP computed across available levels only.`
      );
    }

    // Signed funding impact: sweeping asks pays positive funding; sweeping bids pays negative funding
    const signedHourlyFundingBps =
      (input.side === 'buy' ? fundingRate1hPct : -fundingRate1hPct) * 100;
    const fundingDragBps = Math.max(0, signedHourlyFundingBps * input.holding_hours);
    const roundTripFeeBps = input.taker_fee_bps * 2;
    const roundTripSlippageBps = walk.slippage_vs_mid_bps * 2;
    const totalRoundTripFrictionBps = roundTripFeeBps + roundTripSlippageBps + fundingDragBps;

    const atr = computeWilderAtr({
      candles: candlesRouted.data,
      period: 14,
      accountEquityUsd: input.account_equity_usd,
      riskPerTradePct: 1.0,
      roundTripCostBps: totalRoundTripFrictionBps,
    });

    const stop15x = atr.volatility_stops.find((s) => s.multiplier === 1.5) ?? atr.volatility_stops[0]!;
    const grossRrForBreakeven = input.reward_risk_ratio ?? 1.5;
    const breakeven = computeExecutionBreakeven({
      stopLossPct: stop15x.stop_distance_pct,
      takeProfitPct: stop15x.stop_distance_pct * grossRrForBreakeven,
      roundTripCostBps: totalRoundTripFrictionBps,
    });

    const kellySizing =
      typeof input.win_rate_pct === 'number' && typeof input.reward_risk_ratio === 'number'
        ? computeKellyWithFriction(
            input.win_rate_pct,
            input.reward_risk_ratio,
            breakeven.frictionInR
          )
        : null;

    return {
      meta: createNonAdvisoryMeta(),
      tool: 'preflight_execution_risk',
      asset_symbol: canonicalSymbol,
      venue_used: bookRouted.venueUsed,
      data_freshness_ms: Math.max(bookRouted.dataFreshnessMs, candlesRouted.dataFreshnessMs),
      l2_execution_walk: walk,
      friction_breakdown: {
        round_trip_taker_fee_bps: roundTo(roundTripFeeBps, 4),
        round_trip_slippage_bps: roundTo(roundTripSlippageBps, 4),
        estimated_funding_drag_bps: roundTo(fundingDragBps, 4),
        holding_hours_assumed: input.holding_hours,
        total_round_trip_friction_bps: roundTo(totalRoundTripFrictionBps, 4),
        total_round_trip_friction_usd: roundTo(
          (totalRoundTripFrictionBps / 10_000) * walk.filled_order_usd,
          4
        ),
      },
      breakeven_audit_at_1_5x_atr: {
        assumed_gross_reward_risk: roundTo(grossRrForBreakeven, 4),
        nominal_breakeven_win_rate_pct: breakeven.nominalBreakevenWinPct,
        effective_breakeven_win_rate_pct: breakeven.realBreakevenWinPct,
        win_rate_penalty_pct_points: breakeven.winRatePenaltyPct,
        friction_as_r_multiple: breakeven.frictionInR,
        impossible_target_after_friction: breakeven.impossibleTarget,
      },
      atr_volatility_stops_1h: atr,
      kelly_fraction_audit: kellySizing
        ? {
            half_kelly_risk_pct: kellySizing.halfKellyPct,
            quarter_kelly_risk_pct: kellySizing.quarterKellyPct,
            full_kelly_risk_pct: kellySizing.fullKellyPct,
            zero_fee_full_kelly_pct: kellySizing.zeroFeeFullKellyPct,
            kelly_haircut_pct_points: kellySizing.kellyHaircutPctPoints,
            expected_value_r: kellySizing.expectedValueR,
          }
        : null,
      warnings,
    };
  });
}

/**
 * Tool 2 Handler: scan_venue_microstructure ($0.010)
 */
export async function handleScanVenueMicrostructure(
  rawArgs: unknown,
  deps: ToolRuntimeDependencies
): Promise<McpToolExecutionResponse> {
  return runWithFailClosedBilling('scan-venue-microstructure', deps.billing, async () => {
    const input = ScanVenueMicrostructureInputSchema.parse(rawArgs ?? {});
    const ctxRouted = await deps.router.getMarketContexts(input.symbols, 'auto');
    const warnings = [...ctxRouted.warnings];

    const filtered = ctxRouted.data.filter(
      (item) => item.openInterestUsd >= input.min_open_interest_usd
    );

    if (filtered.length === 0) {
      throw new UpstreamError(
        'NO_PAIRS_MATCH_FILTER',
        `Zero perpetual pairs matched min_open_interest_usd >= ${input.min_open_interest_usd}.`,
        404,
        false
      );
    }

    // Pre-sort candidate pool to cap concurrent L2 book probes <= 20
    const preSorted = [...filtered].sort((a, b) => {
      if (input.sort_by === 'abs_funding_apr') {
        return Math.abs(b.fundingAprPct) - Math.abs(a.fundingAprPct);
      }
      return b.openInterestUsd - a.openInterestUsd;
    });

    const probeCount =
      input.sort_by === 'spread_bps'
        ? Math.min(20, Math.max(input.limit, 12))
        : Math.min(20, input.limit);
    const candidates = preSorted.slice(0, probeCount);

    const venueChoice = ctxRouted.venueUsed === 'okx_fallback' ? 'okx' : 'auto';
    const enriched = await Promise.all(
      candidates.map(async (item) => {
        try {
          const bookRouted = await deps.router.getOrderbook(item.symbol, venueChoice);
          const micro = summarizeOrderbookMicrostructure(
            bookRouted.data.bids,
            bookRouted.data.asks
          );
          return {
            symbol: normalizeSymbol(item.symbol, 'canonical'),
            mark_price: roundTo(item.markPrice, 6),
            mid_price: micro.mid_price,
            funding_rate_1h_pct: roundTo(item.fundingRate1hPct, 6),
            funding_rate_8h_pct: roundTo(item.fundingRate8hPct, 6),
            funding_apr_pct: roundTo(item.fundingAprPct, 4),
            open_interest_usd: roundTo(item.openInterestUsd, 2),
            top_spread_bps: micro.top_spread_bps,
            bid_depth_50bps_usd: micro.bid_depth_50bps_usd,
            ask_depth_50bps_usd: micro.ask_depth_50bps_usd,
            impact_10k_bps: micro.impact_10k_bps,
            impact_100k_bps: micro.impact_100k_bps,
            depth_exhausted_at_100k: micro.depth_exhausted_at_100k,
          };
        } catch {
          warnings.push(`Skipped L2 depth enrichment for "${item.symbol}" due to book fetch error.`);
          return null;
        }
      })
    );

    const validRows = enriched.filter((r): r is NonNullable<typeof r> => r !== null);
    if (validRows.length === 0) {
      throw new UpstreamError(
        'UPSTREAM_UNAVAILABLE',
        'Unable to enrich L2 orderbook depth for any candidate pair.'
      );
    }

    validRows.sort((a, b) => {
      if (input.sort_by === 'abs_funding_apr') {
        return Math.abs(b.funding_apr_pct) - Math.abs(a.funding_apr_pct);
      }
      if (input.sort_by === 'spread_bps') {
        return a.top_spread_bps - b.top_spread_bps;
      }
      return b.open_interest_usd - a.open_interest_usd;
    });

    const finalPairs = validRows.slice(0, input.limit);

    return {
      meta: createNonAdvisoryMeta(),
      tool: 'scan_venue_microstructure',
      venue_used: ctxRouted.venueUsed,
      data_freshness_ms: ctxRouted.dataFreshnessMs,
      pairs_returned: finalPairs.length,
      sort_applied: input.sort_by,
      pairs: finalPairs,
      warnings,
    };
  });
}

/**
 * Tool 3 Handler: audit_indicator_collinearity ($0.025)
 */
export async function handleAuditIndicatorCollinearity(
  rawArgs: unknown,
  deps: ToolRuntimeDependencies
): Promise<McpToolExecutionResponse> {
  return runWithFailClosedBilling('audit-indicator-collinearity', deps.billing, async () => {
    const input = AuditCollinearityInputSchema.parse(rawArgs);

    let matrix: Record<string, number[]>;
    let modeUsed: 'live_ohlcv_indicators' | 'custom_feature_matrix';
    let venueUsed: 'hyperliquid' | 'okx_fallback' | 'deterministic_local' = 'deterministic_local';
    let symbolNormalized: string | null = null;
    const warnings: string[] = [];

    if (input.feature_matrix) {
      modeUsed = 'custom_feature_matrix';
      matrix = input.feature_matrix;
    } else {
      modeUsed = 'live_ohlcv_indicators';
      symbolNormalized = normalizeSymbol(input.symbol!, 'canonical');
      const candlesRouted = await deps.router.getCandles(input.symbol!, input.interval, 180, 'auto');
      venueUsed = candlesRouted.venueUsed;
      warnings.push(...candlesRouted.warnings);
      matrix = buildIndicatorMatrixFromCandles(candlesRouted.data, input.indicators!);
    }

    const audit = auditFeatureCollinearity(matrix);
    const mergedWarnings = [...warnings, ...audit.warnings];

    return {
      meta: createNonAdvisoryMeta(),
      tool: 'audit_indicator_collinearity',
      input_mode: modeUsed,
      symbol: symbolNormalized,
      venue_used: venueUsed,
      observations_analyzed: audit.observations_analyzed,
      active_features: audit.active_features,
      constant_columns_excluded: audit.constant_columns_excluded,
      vif_by_feature: audit.vif_by_feature,
      high_correlation_pairs: audit.high_correlation_pairs,
      condition_number: audit.condition_number,
      effective_rank: audit.effective_rank,
      collinearity_severity: audit.collinearity_severity,
      independent_info_retention_pct: audit.independent_info_retention_pct,
      orthogonal_weights: audit.orthogonal_weights,
      max_off_diagonal_dot: audit.max_off_diagonal_dot,
      warnings: mergedWarnings,
    };
  });
}

/**
 * Tool 4 Handler: simulate_backtest_reality ($0.025)
 */
export async function handleSimulateBacktestReality(
  rawArgs: unknown,
  deps: ToolRuntimeDependencies
): Promise<McpToolExecutionResponse> {
  return runWithFailClosedBilling('simulate-backtest-reality', deps.billing, async () => {
    const input = SimulateBacktestRealityInputSchema.parse(rawArgs);
    const warnings: string[] = [];
    let effectiveCostBps = input.round_trip_cost_bps;
    let frictionSource: 'manual_round_trip_bps' | 'live_l2_book_walk' = 'manual_round_trip_bps';
    let venueUsed: 'hyperliquid' | 'okx_fallback' | 'deterministic_local' = 'deterministic_local';

    if (input.symbol && typeof input.order_size_usd === 'number') {
      const bookRouted = await deps.router.getOrderbook(input.symbol, 'auto');
      venueUsed = bookRouted.venueUsed;
      warnings.push(...bookRouted.warnings);

      const askWalk = walkOrderbookL2({
        bids: bookRouted.data.bids,
        asks: bookRouted.data.asks,
        side: 'buy',
        orderSizeUsd: input.order_size_usd,
      });
      const bidWalk = walkOrderbookL2({
        bids: bookRouted.data.bids,
        asks: bookRouted.data.asks,
        side: 'sell',
        orderSizeUsd: input.order_size_usd,
      });

      effectiveCostBps =
        input.taker_fee_bps * 2 + askWalk.slippage_vs_mid_bps + bidWalk.slippage_vs_mid_bps;
      frictionSource = 'live_l2_book_walk';

      if (askWalk.insufficient_book_depth || bidWalk.insufficient_book_depth) {
        warnings.push(
          'INSUFFICIENT_BOOK_DEPTH: Requested order_size_usd exceeded visible L2 depth during slippage injection.'
        );
      }
    }

    const sim = simulateBacktestReality5000({
      winRatePct: input.win_rate_pct,
      avgWinPct: input.avg_win_pct,
      avgLossPct: input.avg_loss_pct,
      numTrades: input.num_trades,
      riskPerTradePct: input.risk_per_trade_pct,
      roundTripCostBps: effectiveCostBps,
      ruinDrawdownPct: input.ruin_drawdown_pct,
      seed: input.seed,
      paths: 5000,
    });

    if (sim.impossible_target_after_friction) {
      warnings.push(
        'IMPOSSIBLE_TARGET: Round-trip execution cost equals or exceeds gross avg_win_pct; net expectancy is strictly negative.'
      );
    }

    return {
      meta: createNonAdvisoryMeta(),
      tool: 'simulate_backtest_reality',
      friction_source: frictionSource,
      venue_used: venueUsed,
      simulation: sim,
      warnings,
    };
  });
}

/**
 * Direct programmatic dispatcher (used by Apify Console batch mode & automated tests).
 */
export async function executeToolByName(
  toolName: string,
  rawArgs: unknown,
  deps: ToolRuntimeDependencies
): Promise<McpToolExecutionResponse> {
  switch (toolName) {
    case 'preflight_execution_risk':
      return handlePreflightExecutionRisk(rawArgs, deps);
    case 'scan_venue_microstructure':
      return handleScanVenueMicrostructure(rawArgs, deps);
    case 'audit_indicator_collinearity':
      return handleAuditIndicatorCollinearity(rawArgs, deps);
    case 'simulate_backtest_reality':
      return handleSimulateBacktestReality(rawArgs, deps);
    default:
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: {
                code: 'UNKNOWN_TOOL',
                message: `Unknown tool "${toolName}". Valid tools: ${FROZEN_TOOL_NAMES.join(', ')}.`,
              },
            }),
          },
        ],
      };
  }
}

/**
 * Registers the strictly frozen 4 single-responsibility `verb_noun` tools onto an `McpServer`.
 */
export function registerQuantPreflightTools(
  server: McpServer,
  deps: ToolRuntimeDependencies
): void {
  server.tool(
    'preflight_execution_risk',
    'WHEN TO USE: Call immediately before sizing or simulating a perpetual futures order to measure live L2 orderbook VWAP slippage (bps & USD), fee + funding drag, 14-period Wilder ATR volatility stop distances, breakeven win-rate inflation, and Half-Kelly risk caps. WHEN NOT TO USE: Do not call for multi-asset market scanning (use scan_venue_microstructure) or multi-indicator correlation checks (use audit_indicator_collinearity). Strictly non-advisory quantitative analytics.',
    PreflightExecutionInputShape,
    async (args) => handlePreflightExecutionRisk(args, deps)
  );

  server.tool(
    'scan_venue_microstructure',
    'WHEN TO USE: Call when comparing perpetual futures pairs across live annualized funding rates (APR%), open interest (USD), top-of-book bid-ask spread (bps), and $10k/$100k L2 market-impact depth. WHEN NOT TO USE: Do not call to compute ATR stops or Kelly sizing for one specific order (use preflight_execution_risk). Strictly non-advisory market microstructure snapshot.',
    ScanVenueMicrostructureInputShape,
    async (args) => handleScanVenueMicrostructure(args, deps)
  );

  server.tool(
    'audit_indicator_collinearity',
    'WHEN TO USE: Call when auditing a set of technical indicators or quantitative alpha features for multicollinearity ("1 feature wearing 10 masks" overfitting) via Ridge-regularized VIF, symmetric eigenvalue Condition Number, and 2-pass Modified Gram-Schmidt orthogonal weights. Supports Mode A (auto-fetched OHLCV + built-in indicators) or Mode B (custom numeric feature_matrix). WHEN NOT TO USE: Do not call for Monte Carlo equity drawdown trajectories (use simulate_backtest_reality).',
    AuditCollinearityInputShape,
    async (args) => handleAuditIndicatorCollinearity(args, deps)
  );

  server.tool(
    'simulate_backtest_reality',
    'WHEN TO USE: Call when stress-testing a strategy backtest (win rate, average win %, average loss %, risk %, trade count) against realistic round-trip execution fees/slippage (or live L2 book-walk slippage) across 5,000 deterministic Mulberry32 Monte Carlo equity paths and exact absorbing Markov chain losing-streak probabilities (4, 6, 8, 10, 12 consecutive losses). WHEN NOT TO USE: Do not call for indicator correlation matrices (use audit_indicator_collinearity).',
    SimulateBacktestRealityInputShape,
    async (args) => handleSimulateBacktestReality(args, deps)
  );
}
