import type { OhlcvCandle } from '../engine/indicators.js';
import {
  CACHE_TTL_MS,
  CircuitBreaker,
  LruTtlCache,
  type MarketVenueAdapter,
  type NormalizedAssetMicrostructure,
  type NormalizedOrderbookSnapshot,
  UpstreamError,
} from './cacheAndBreaker.js';
import { HyperliquidAdapter } from './hyperliquidAdapter.js';
import { OkxSwapAdapter } from './okxAdapter.js';

export type TargetVenueChoice = 'hyperliquid' | 'okx' | 'auto';

const HL_KILO_TICKERS = new Set(['PEPE', 'BONK', 'SHIB', 'FLOKI', 'LUNC', 'NEIRO']);

/**
 * Normalizes diverse user/agent symbol formats (`BTC`, `BTCUSDT`, `BTC-PERP`, `BTC-USDT-SWAP`,
 * `kPEPE`, `1000PEPE`, `btc/usdt`) into canonical venue-specific perpetual tickers.
 */
export function normalizeSymbol(
  rawSymbol: string,
  venue: 'hyperliquid' | 'okx_fallback' | 'canonical'
): string {
  let clean = rawSymbol.trim().toUpperCase().replace(/\s+/g, '');
  clean = clean.replace(/[/_]/g, '-');

  // Strip common perpetual & quote suffixes safely
  clean = clean.replace(/-(USDT|USDC|USD)-(SWAP|PERP)$/i, '');
  clean = clean.replace(/-(SWAP|PERP)$/i, '');
  clean = clean.replace(/-(USDT|USDC|USD)$/i, '');

  if (clean.length > 5 && /(USDT|USDC)$/.test(clean)) {
    clean = clean.replace(/(USDT|USDC)$/, '');
  } else if (clean.length > 5 && /PERP$/.test(clean)) {
    clean = clean.replace(/PERP$/, '');
  }

  // Extract base token without 1000 / k multiplier prefix
  let baseToken = clean;
  if (/^1000[A-Z0-9]+$/.test(baseToken)) {
    baseToken = baseToken.slice(4);
  } else if (/^K(PEPE|BONK|SHIB|FLOKI|LUNC|NEIRO)$/.test(baseToken)) {
    baseToken = baseToken.slice(1);
  }

  if (!/^[A-Z0-9]{1,16}$/.test(baseToken)) {
    throw new UpstreamError(
      'INVALID_SYMBOL',
      `Invalid symbol format "${rawSymbol}". Provide a valid alphanumeric asset ticker such as "BTC", "ETH", or "SOL".`,
      400,
      false
    );
  }

  if (venue === 'canonical') {
    return baseToken;
  }

  if (venue === 'hyperliquid') {
    if (HL_KILO_TICKERS.has(baseToken)) {
      return `k${baseToken}`;
    }
    return baseToken;
  }

  // OKX USDT-margined linear perpetual swap format
  return `${baseToken}-USDT-SWAP`;
}

export interface RoutedResult<T> {
  data: T;
  venueUsed: 'hyperliquid' | 'okx_fallback';
  cacheHit: boolean;
  dataFreshnessMs: number;
  warnings: string[];
}

/**
 * Multi-Venue Router with 2-Tier TTL Cache (3s microstructure / 30s candles) &
 * 2,500ms Timeout + 3-Strike 30s Circuit Breaker Failover.
 */
export class VenueRouter {
  private readonly primary: MarketVenueAdapter;
  private readonly fallback: MarketVenueAdapter;
  private readonly primaryBreaker: CircuitBreaker;
  private readonly fallbackBreaker: CircuitBreaker;
  private readonly cache: LruTtlCache<unknown>;

  constructor(opts?: {
    primary?: MarketVenueAdapter;
    fallback?: MarketVenueAdapter;
    primaryBreaker?: CircuitBreaker;
    fallbackBreaker?: CircuitBreaker;
    cache?: LruTtlCache<unknown>;
  }) {
    this.primary = opts?.primary ?? new HyperliquidAdapter();
    this.fallback = opts?.fallback ?? new OkxSwapAdapter();
    this.primaryBreaker = opts?.primaryBreaker ?? new CircuitBreaker(3, 30_000);
    this.fallbackBreaker = opts?.fallbackBreaker ?? new CircuitBreaker(3, 30_000);
    this.cache = opts?.cache ?? new LruTtlCache<unknown>(200);
  }

  private getOrderedCandidates(choice: TargetVenueChoice): {
    adapter: MarketVenueAdapter;
    breaker: CircuitBreaker;
  }[] {
    if (choice === 'hyperliquid') {
      return [{ adapter: this.primary, breaker: this.primaryBreaker }];
    }
    if (choice === 'okx') {
      return [{ adapter: this.fallback, breaker: this.fallbackBreaker }];
    }
    return [
      { adapter: this.primary, breaker: this.primaryBreaker },
      { adapter: this.fallback, breaker: this.fallbackBreaker },
    ];
  }

  public async getOrderbook(
    rawSymbol: string,
    venueChoice: TargetVenueChoice = 'auto'
  ): Promise<RoutedResult<NormalizedOrderbookSnapshot>> {
    const canonical = normalizeSymbol(rawSymbol, 'canonical');
    const candidates = this.getOrderedCandidates(venueChoice);
    const warnings: string[] = [];
    const errors: string[] = [];

    for (let idx = 0; idx < candidates.length; idx++) {
      const { adapter, breaker } = candidates[idx]!;
      const venueSym = normalizeSymbol(canonical, adapter.venueId);
      const cacheKey = `book:${adapter.venueId}:${venueSym}`;

      const cached = this.cache.get(cacheKey) as
        | { value: NormalizedOrderbookSnapshot; ageMs: number }
        | undefined;
      if (cached) {
        return {
          data: cached.value,
          venueUsed: adapter.venueId,
          cacheHit: true,
          dataFreshnessMs: cached.ageMs,
          warnings,
        };
      }

      if (!breaker.canRequest()) {
        warnings.push(`Venue ${adapter.venueId} circuit is OPEN; routing to next available venue.`);
        errors.push(`${adapter.venueId}: circuit_open`);
        continue;
      }

      try {
        const book = await adapter.fetchOrderbook(venueSym);
        breaker.recordSuccess();
        this.cache.set(cacheKey, book, CACHE_TTL_MS.MICROSTRUCTURE);
        if (idx > 0) {
          warnings.push(
            `Primary venue degraded (${errors.join('; ')}); served live L2 book via ${adapter.venueId}.`
          );
        }
        return {
          data: book,
          venueUsed: adapter.venueId,
          cacheHit: false,
          dataFreshnessMs: 0,
          warnings,
        };
      } catch (err) {
        const statusCode = err instanceof UpstreamError ? err.statusCode : undefined;
        // Do not trip venue-wide circuit breaker on user typo / unlisted 404 symbol
        if (!(err instanceof UpstreamError && err.code === 'SYMBOL_NOT_FOUND')) {
          breaker.recordFailure(statusCode);
        }
        errors.push(`${adapter.venueId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new UpstreamError(
      'UPSTREAM_UNAVAILABLE',
      `All market venues failed for orderbook "${canonical}" (${errors.join(' | ')}).`,
      503,
      true
    );
  }

  public async getMarketContexts(
    rawSymbols?: string[],
    venueChoice: TargetVenueChoice = 'auto'
  ): Promise<RoutedResult<NormalizedAssetMicrostructure[]>> {
    const canonicalList = rawSymbols?.map((s) => normalizeSymbol(s, 'canonical'));
    const candidates = this.getOrderedCandidates(venueChoice);
    const warnings: string[] = [];
    const errors: string[] = [];

    for (let idx = 0; idx < candidates.length; idx++) {
      const { adapter, breaker } = candidates[idx]!;
      const venueSyms = canonicalList?.map((c) => normalizeSymbol(c, adapter.venueId));
      const symKey = venueSyms ? venueSyms.slice().sort().join(',') : 'ALL';
      const cacheKey = `ctx:${adapter.venueId}:${symKey}`;

      const cached = this.cache.get(cacheKey) as
        | { value: NormalizedAssetMicrostructure[]; ageMs: number }
        | undefined;
      if (cached) {
        return {
          data: cached.value,
          venueUsed: adapter.venueId,
          cacheHit: true,
          dataFreshnessMs: cached.ageMs,
          warnings,
        };
      }

      if (!breaker.canRequest()) {
        warnings.push(`Venue ${adapter.venueId} circuit is OPEN; routing to next available venue.`);
        errors.push(`${adapter.venueId}: circuit_open`);
        continue;
      }

      try {
        const ctxs = await adapter.fetchMarketContexts(venueSyms);
        if (ctxs.length === 0) {
          throw new UpstreamError(
            'EMPTY_MARKET_CONTEXT',
            `Venue ${adapter.venueId} returned zero matching perpetual pairs.`
          );
        }
        breaker.recordSuccess();
        this.cache.set(cacheKey, ctxs, CACHE_TTL_MS.MICROSTRUCTURE);
        if (idx > 0) {
          warnings.push(
            `Primary venue degraded (${errors.join('; ')}); served market contexts via ${adapter.venueId}.`
          );
        }
        return {
          data: ctxs,
          venueUsed: adapter.venueId,
          cacheHit: false,
          dataFreshnessMs: 0,
          warnings,
        };
      } catch (err) {
        const statusCode = err instanceof UpstreamError ? err.statusCode : undefined;
        breaker.recordFailure(statusCode);
        errors.push(`${adapter.venueId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new UpstreamError(
      'UPSTREAM_UNAVAILABLE',
      `All market venues failed for market microstructure scan (${errors.join(' | ')}).`,
      503,
      true
    );
  }

  public async getCandles(
    rawSymbol: string,
    interval: '15m' | '1h' | '4h' | '1d',
    limit = 120,
    venueChoice: TargetVenueChoice = 'auto'
  ): Promise<RoutedResult<OhlcvCandle[]>> {
    const canonical = normalizeSymbol(rawSymbol, 'canonical');
    const candidates = this.getOrderedCandidates(venueChoice);
    const warnings: string[] = [];
    const errors: string[] = [];

    for (let idx = 0; idx < candidates.length; idx++) {
      const { adapter, breaker } = candidates[idx]!;
      const venueSym = normalizeSymbol(canonical, adapter.venueId);
      const cacheKey = `candles:${adapter.venueId}:${venueSym}:${interval}:${limit}`;

      const cached = this.cache.get(cacheKey) as
        | { value: OhlcvCandle[]; ageMs: number }
        | undefined;
      if (cached) {
        return {
          data: cached.value,
          venueUsed: adapter.venueId,
          cacheHit: true,
          dataFreshnessMs: cached.ageMs,
          warnings,
        };
      }

      if (!breaker.canRequest()) {
        warnings.push(`Venue ${adapter.venueId} circuit is OPEN; routing to next available venue.`);
        errors.push(`${adapter.venueId}: circuit_open`);
        continue;
      }

      try {
        const candles = await adapter.fetchCandles(venueSym, interval, limit);
        breaker.recordSuccess();
        // 30,000ms TTL for OHLCV candles (2-tier cache separation)
        this.cache.set(cacheKey, candles, CACHE_TTL_MS.CANDLES);
        if (idx > 0) {
          warnings.push(
            `Primary venue degraded (${errors.join('; ')}); served OHLCV candles via ${adapter.venueId}.`
          );
        }
        return {
          data: candles,
          venueUsed: adapter.venueId,
          cacheHit: false,
          dataFreshnessMs: 0,
          warnings,
        };
      } catch (err) {
        const statusCode = err instanceof UpstreamError ? err.statusCode : undefined;
        if (!(err instanceof UpstreamError && err.code === 'SYMBOL_NOT_FOUND')) {
          breaker.recordFailure(statusCode);
        }
        errors.push(`${adapter.venueId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new UpstreamError(
      'UPSTREAM_UNAVAILABLE',
      `All market venues failed for OHLCV candles "${canonical}" (${errors.join(' | ')}).`,
      503,
      true
    );
  }
}
