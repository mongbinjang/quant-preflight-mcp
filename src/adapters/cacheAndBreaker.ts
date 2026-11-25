import type { L2BookLevel } from '../engine/quantEngine.js';
import type { OhlcvCandle } from '../engine/indicators.js';

export const ALLOWED_UPSTREAM_HOSTS = new Set<string>([
  'api.hyperliquid.xyz',
  'www.okx.com',
]);

export const CACHE_TTL_MS = {
  MICROSTRUCTURE: 3_000, // 3s TTL for l2Book & metaAndAssetCtxs / funding / OI
  CANDLES: 30_000, // 30s TTL for candleSnapshot
  INSTRUMENTS: 300_000, // 5m TTL for static contract specs (ctVal)
} as const;

export class UpstreamError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;
  public readonly retryable: boolean;

  constructor(code: string, message: string, statusCode?: number, retryable = true) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export interface CacheLookupResult<T> {
  value: T;
  ageMs: number;
}

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
}

/**
 * Bounded LRU + Per-Key TTL In-Memory Cache (prevents Standby container memory leaks).
 * Supports 2-tier TTL separation (3,000ms microstructure vs. 30,000ms candles).
 */
export class LruTtlCache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly nowFn: () => number;

  constructor(maxEntries = 200, nowFn: () => number = () => Date.now()) {
    this.maxEntries = Math.max(10, maxEntries);
    this.nowFn = nowFn;
  }

  public get(key: string): CacheLookupResult<T> | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    const now = this.nowFn();
    if (now >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, entry);
    return {
      value: entry.value,
      ageMs: Math.max(0, now - entry.createdAt),
    };
  }

  public set(key: string, value: T, ttlMs: number): void {
    const now = this.nowFn();
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Evict expired first, else oldest LRU key
      let evicted = false;
      for (const [k, v] of this.store.entries()) {
        if (now >= v.expiresAt) {
          this.store.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
        }
      }
    }

    this.store.set(key, {
      value,
      createdAt: now,
      expiresAt: now + Math.max(1, ttlMs),
    });
  }

  public size(): number {
    return this.store.size;
  }

  public clear(): void {
    this.store.clear();
  }
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Per-Venue Circuit Breaker:
 * - Trips OPEN for 30s after 3 consecutive failures or immediate HTTP 429 / 5xx burst.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;

  constructor(
    failureThreshold = 3,
    cooldownMs = 30_000,
    nowFn: () => number = () => Date.now()
  ) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.nowFn = nowFn;
  }

  public canRequest(): boolean {
    if (this.state === 'CLOSED' || this.state === 'HALF_OPEN') return true;
    const now = this.nowFn();
    if (now - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(statusCode?: number): void {
    this.consecutiveFailures += 1;
    if (
      statusCode === 429 ||
      statusCode === 451 ||
      statusCode === 403 ||
      this.consecutiveFailures >= this.failureThreshold ||
      this.state === 'HALF_OPEN'
    ) {
      this.state = 'OPEN';
      this.openedAt = this.nowFn();
    }
  }

  public getState(): CircuitState {
    // Allow lazy transition check
    this.canRequest();
    return this.state;
  }
}

export type FetchLike = typeof globalThis.fetch;

/**
 * SSRF-Guarded + 2,500ms AbortController Timeout JSON Fetcher.
 */
export async function safeUpstreamFetchJson<T>(
  urlStr: string,
  init: RequestInit = {},
  timeoutMs = 2_500,
  fetchImpl: FetchLike = globalThis.fetch
): Promise<T> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new UpstreamError('INVALID_UPSTREAM_URL', 'Malformed upstream URL.', undefined, false);
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_UPSTREAM_HOSTS.has(parsed.hostname)) {
    throw new UpstreamError(
      'SSRF_HOST_BLOCKED',
      `Host "${parsed.hostname}" is not in ALLOWED_UPSTREAM_HOSTS.`,
      undefined,
      false
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(parsed.toString(), {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      throw new UpstreamError(
        `UPSTREAM_HTTP_${res.status}`,
        `Upstream ${parsed.hostname} returned HTTP ${res.status}.`,
        res.status,
        res.status === 429 || res.status >= 500
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
      throw new UpstreamError(
        'UPSTREAM_TIMEOUT',
        `Upstream ${parsed.hostname} timed out after ${timeoutMs}ms.`,
        504,
        true
      );
    }
    throw new UpstreamError(
      'UPSTREAM_NETWORK_ERROR',
      err instanceof Error ? err.message : 'Unknown upstream network error',
      undefined,
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface NormalizedOrderbookSnapshot {
  venue: 'hyperliquid' | 'okx_fallback';
  normalizedSymbol: string;
  bids: L2BookLevel[];
  asks: L2BookLevel[];
  timestampMs: number;
}

export interface NormalizedAssetMicrostructure {
  symbol: string;
  venueSymbol: string;
  markPrice: number;
  midPrice: number;
  fundingRate1hPct: number;
  fundingRate8hPct: number;
  fundingAprPct: number;
  openInterestUsd: number;
}

export interface MarketVenueAdapter {
  readonly venueId: 'hyperliquid' | 'okx_fallback';
  fetchOrderbook(normalizedVenueSymbol: string): Promise<NormalizedOrderbookSnapshot>;
  fetchMarketContexts(normalizedVenueSymbols?: string[]): Promise<NormalizedAssetMicrostructure[]>;
  fetchCandles(
    normalizedVenueSymbol: string,
    interval: '15m' | '1h' | '4h' | '1d',
    limit: number
  ): Promise<OhlcvCandle[]>;
}
