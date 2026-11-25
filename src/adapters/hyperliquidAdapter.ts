import type { OhlcvCandle } from '../engine/indicators.js';
import {
  type FetchLike,
  type MarketVenueAdapter,
  type NormalizedAssetMicrostructure,
  type NormalizedOrderbookSnapshot,
  UpstreamError,
  safeUpstreamFetchJson,
} from './cacheAndBreaker.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

interface HlBookLevelRaw {
  px: string;
  sz: string;
  n?: number;
}

interface HlBookResponse {
  coin: string;
  time: number;
  levels: [HlBookLevelRaw[], HlBookLevelRaw[]];
}

interface HlMetaUniverseItem {
  name: string;
  szDecimals: number;
  isDelisted?: boolean;
}

interface HlAssetCtxRaw {
  funding: string;
  openInterest: string;
  markPx: string;
  midPx?: string | null;
  oraclePx?: string;
}

type HlMetaAndAssetCtxsResponse = [{ universe: HlMetaUniverseItem[] }, HlAssetCtxRaw[]];

interface HlCandleRaw {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
}

const INTERVAL_MS: Record<'15m' | '1h' | '4h' | '1d', number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

/**
 * Primary Venue Adapter: Hyperliquid Public REST API (`POST https://api.hyperliquid.xyz/info`)
 * Zero API keys, zero proxy cost, globally open L2 orderbook + funding + OHLCV snapshots.
 */
export class HyperliquidAdapter implements MarketVenueAdapter {
  public readonly venueId = 'hyperliquid' as const;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(timeoutMs = 2_500, fetchImpl: FetchLike = globalThis.fetch) {
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  public async fetchOrderbook(coin: string): Promise<NormalizedOrderbookSnapshot> {
    const data = await safeUpstreamFetchJson<HlBookResponse | null>(
      HL_INFO_URL,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'l2Book', coin }),
      },
      this.timeoutMs,
      this.fetchImpl
    );

    if (!data || !Array.isArray(data.levels) || data.levels.length < 2) {
      throw new UpstreamError(
        'SYMBOL_NOT_FOUND',
        `Hyperliquid returned no L2 orderbook for symbol "${coin}".`,
        404,
        false
      );
    }

    const rawBids = data.levels[0] ?? [];
    const rawAsks = data.levels[1] ?? [];
    if (rawBids.length === 0 || rawAsks.length === 0) {
      throw new UpstreamError(
        'SYMBOL_NOT_FOUND',
        `Hyperliquid orderbook is empty or unlisted for "${coin}".`,
        404,
        false
      );
    }

    const bids = rawBids
      .map((b) => ({ price: Number(b.px), size: Number(b.sz) }))
      .filter((b) => Number.isFinite(b.price) && Number.isFinite(b.size) && b.price > 0 && b.size > 0);
    const asks = rawAsks
      .map((a) => ({ price: Number(a.px), size: Number(a.sz) }))
      .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.price > 0 && a.size > 0);

    return {
      venue: 'hyperliquid',
      normalizedSymbol: coin,
      bids,
      asks,
      timestampMs: typeof data.time === 'number' ? data.time : Date.now(),
    };
  }

  public async fetchMarketContexts(
    filterCoins?: string[]
  ): Promise<NormalizedAssetMicrostructure[]> {
    const data = await safeUpstreamFetchJson<HlMetaAndAssetCtxsResponse>(
      HL_INFO_URL,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      },
      this.timeoutMs,
      this.fetchImpl
    );

    if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[0]?.universe)) {
      throw new UpstreamError(
        'INVALID_UPSTREAM_SCHEMA',
        'Unexpected Hyperliquid metaAndAssetCtxs response shape.'
      );
    }

    const universe = data[0].universe;
    const ctxs = data[1];
    const filterSet =
      filterCoins && filterCoins.length > 0 ? new Set(filterCoins) : undefined;

    const results: NormalizedAssetMicrostructure[] = [];
    const len = Math.min(universe.length, ctxs.length);

    for (let i = 0; i < len; i++) {
      const meta = universe[i]!;
      const ctx = ctxs[i]!;
      if (meta.isDelisted) continue;
      if (filterSet && !filterSet.has(meta.name)) continue;

      const markPrice = Number(ctx.markPx);
      const midPrice = ctx.midPx ? Number(ctx.midPx) : markPrice;
      const fundingHourlyDecimal = Number(ctx.funding);
      const oiCoins = Number(ctx.openInterest);

      if (!Number.isFinite(markPrice) || markPrice <= 0) continue;

      const rate1hPct = Number.isFinite(fundingHourlyDecimal) ? fundingHourlyDecimal * 100 : 0;
      const rate8hPct = rate1hPct * 8;
      const aprPct = rate1hPct * 24 * 365;
      const oiUsd = Number.isFinite(oiCoins) && oiCoins >= 0 ? oiCoins * markPrice : 0;

      results.push({
        symbol: meta.name,
        venueSymbol: meta.name,
        markPrice,
        midPrice: Number.isFinite(midPrice) && midPrice > 0 ? midPrice : markPrice,
        fundingRate1hPct: rate1hPct,
        fundingRate8hPct: rate8hPct,
        fundingAprPct: aprPct,
        openInterestUsd: oiUsd,
      });
    }

    return results;
  }

  public async fetchCandles(
    coin: string,
    interval: '15m' | '1h' | '4h' | '1d',
    limit = 120
  ): Promise<OhlcvCandle[]> {
    const endTime = Date.now();
    const startTime = endTime - Math.max(30, limit + 10) * INTERVAL_MS[interval];

    const data = await safeUpstreamFetchJson<HlCandleRaw[]>(
      HL_INFO_URL,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: {
            coin,
            interval,
            startTime,
            endTime,
          },
        }),
      },
      this.timeoutMs,
      this.fetchImpl
    );

    if (!Array.isArray(data) || data.length === 0) {
      throw new UpstreamError(
        'SYMBOL_NOT_FOUND',
        `Hyperliquid returned zero candles for "${coin}" (${interval}).`,
        404,
        false
      );
    }

    return data
      .map((c) => ({
        timestamp: Number(c.t),
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.timestamp) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.close > 0
      )
      .slice(-limit);
  }
}
