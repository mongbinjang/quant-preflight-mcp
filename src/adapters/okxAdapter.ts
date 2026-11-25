import type { OhlcvCandle } from '../engine/indicators.js';
import {
  CACHE_TTL_MS,
  type FetchLike,
  LruTtlCache,
  type MarketVenueAdapter,
  type NormalizedAssetMicrostructure,
  type NormalizedOrderbookSnapshot,
  UpstreamError,
  safeUpstreamFetchJson,
} from './cacheAndBreaker.js';

const OKX_BASE = 'https://www.okx.com';

interface OkxEnvelope<T> {
  code: string;
  msg: string;
  data: T[];
}

interface OkxInstrumentRaw {
  instId: string;
  ctVal: string;
  state: string;
}

interface OkxBookRaw {
  asks: [string, string, string, string][];
  bids: [string, string, string, string][];
  ts: string;
}

interface OkxTickerRaw {
  instId: string;
  last: string;
  bidPx: string;
  askPx: string;
}

interface OkxOpenInterestRaw {
  instId: string;
  oiUsd: string;
}

interface OkxFundingRaw {
  instId: string;
  fundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
}

const OKX_BAR_MAP: Record<'15m' | '1h' | '4h' | '1d', string> = {
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

/**
 * Secondary Fallback Venue Adapter: OKX Public v5 Swap REST API
 * Converts contract quantities via `ctVal` so base sizes and USD notionals match 1:1.
 */
export class OkxSwapAdapter implements MarketVenueAdapter {
  public readonly venueId = 'okx_fallback' as const;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly specCache = new LruTtlCache<Map<string, number>>(8);

  constructor(timeoutMs = 2_500, fetchImpl: FetchLike = globalThis.fetch) {
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  private async getContractMultiplierMap(): Promise<Map<string, number>> {
    const cached = this.specCache.get('okx_swap_specs');
    if (cached) return cached.value;

    const resp = await safeUpstreamFetchJson<OkxEnvelope<OkxInstrumentRaw>>(
      `${OKX_BASE}/api/v5/public/instruments?instType=SWAP`,
      { method: 'GET' },
      this.timeoutMs,
      this.fetchImpl
    );

    if (!resp || resp.code !== '0' || !Array.isArray(resp.data)) {
      throw new UpstreamError('INVALID_UPSTREAM_SCHEMA', 'Failed to load OKX Swap instrument specs.');
    }

    const map = new Map<string, number>();
    for (const item of resp.data) {
      const ctVal = Number(item.ctVal);
      if (item.instId && Number.isFinite(ctVal) && ctVal > 0) {
        map.set(item.instId, ctVal);
      }
    }
    this.specCache.set('okx_swap_specs', map, CACHE_TTL_MS.INSTRUMENTS);
    return map;
  }

  public async fetchOrderbook(instId: string): Promise<NormalizedOrderbookSnapshot> {
    const [specMap, bookResp] = await Promise.all([
      this.getContractMultiplierMap(),
      safeUpstreamFetchJson<OkxEnvelope<OkxBookRaw>>(
        `${OKX_BASE}/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=50`,
        { method: 'GET' },
        this.timeoutMs,
        this.fetchImpl
      ),
    ]);

    if (!bookResp || bookResp.code !== '0' || !bookResp.data?.[0]) {
      throw new UpstreamError(
        'SYMBOL_NOT_FOUND',
        `OKX Swap orderbook unavailable for "${instId}" (${bookResp?.msg ?? 'no data'}).`,
        404,
        false
      );
    }

    const ctVal = specMap.get(instId) ?? 1;
    const raw = bookResp.data[0];

    const bids = (raw.bids ?? [])
      .map((b) => ({ price: Number(b[0]), size: Number(b[1]) * ctVal }))
      .filter((b) => Number.isFinite(b.price) && Number.isFinite(b.size) && b.price > 0 && b.size > 0);
    const asks = (raw.asks ?? [])
      .map((a) => ({ price: Number(a[0]), size: Number(a[1]) * ctVal }))
      .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.price > 0 && a.size > 0);

    if (bids.length === 0 || asks.length === 0) {
      throw new UpstreamError('EMPTY_ORDERBOOK', `OKX returned empty L2 book for "${instId}".`, 404, false);
    }

    return {
      venue: 'okx_fallback',
      normalizedSymbol: instId,
      bids,
      asks,
      timestampMs: Number(raw.ts) || Date.now(),
    };
  }

  public async fetchMarketContexts(
    filterInstIds?: string[]
  ): Promise<NormalizedAssetMicrostructure[]> {
    const [tickersResp, oiResp] = await Promise.all([
      safeUpstreamFetchJson<OkxEnvelope<OkxTickerRaw>>(
        `${OKX_BASE}/api/v5/market/tickers?instType=SWAP`,
        { method: 'GET' },
        this.timeoutMs,
        this.fetchImpl
      ),
      safeUpstreamFetchJson<OkxEnvelope<OkxOpenInterestRaw>>(
        `${OKX_BASE}/api/v5/public/open-interest?instType=SWAP`,
        { method: 'GET' },
        this.timeoutMs,
        this.fetchImpl
      ),
    ]);

    if (!tickersResp || tickersResp.code !== '0' || !oiResp || oiResp.code !== '0') {
      throw new UpstreamError('INVALID_UPSTREAM_SCHEMA', 'OKX Swap tickers or open-interest call failed.');
    }

    const oiMap = new Map<string, number>();
    for (const row of oiResp.data ?? []) {
      const usd = Number(row.oiUsd);
      if (row.instId && Number.isFinite(usd) && usd >= 0) {
        oiMap.set(row.instId, usd);
      }
    }

    const filterSet =
      filterInstIds && filterInstIds.length > 0 ? new Set(filterInstIds) : undefined;

    const usdtSwaps = (tickersResp.data ?? [])
      .filter((t) => t.instId.endsWith('-USDT-SWAP') && (!filterSet || filterSet.has(t.instId)))
      .map((t) => {
        const last = Number(t.last);
        const bid = Number(t.bidPx);
        const ask = Number(t.askPx);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
        const oiUsd = oiMap.get(t.instId) ?? 0;
        return { instId: t.instId, markPrice: last, midPrice: mid, oiUsd };
      })
      .filter((t) => Number.isFinite(t.markPrice) && t.markPrice > 0)
      .sort((a, b) => b.oiUsd - a.oiUsd)
      .slice(0, 20);

    // Fetch funding rates concurrently for top candidates (bounded <= 20)
    const fundingEntries = await Promise.all(
      usdtSwaps.map(async (item) => {
        try {
          const fResp = await safeUpstreamFetchJson<OkxEnvelope<OkxFundingRaw>>(
            `${OKX_BASE}/api/v5/public/funding-rate?instId=${encodeURIComponent(item.instId)}`,
            { method: 'GET' },
            this.timeoutMs,
            this.fetchImpl
          );
          const fRow = fResp.data?.[0];
          const rawRate = Number(fRow?.fundingRate ?? 0);
          const t0 = Number(fRow?.fundingTime ?? 0);
          const t1 = Number(fRow?.nextFundingTime ?? 0);
          const intervalHours =
            t1 > t0 && (t1 - t0) / 3_600_000 >= 1 ? Math.round((t1 - t0) / 3_600_000) : 8;
          const rate1hPct = Number.isFinite(rawRate) ? (rawRate * 100) / intervalHours : 0;
          return {
            symbol: item.instId.replace(/-USDT-SWAP$/, ''),
            venueSymbol: item.instId,
            markPrice: item.markPrice,
            midPrice: item.midPrice,
            fundingRate1hPct: rate1hPct,
            fundingRate8hPct: rate1hPct * 8,
            fundingAprPct: rate1hPct * 24 * 365,
            openInterestUsd: item.oiUsd,
          };
        } catch {
          return {
            symbol: item.instId.replace(/-USDT-SWAP$/, ''),
            venueSymbol: item.instId,
            markPrice: item.markPrice,
            midPrice: item.midPrice,
            fundingRate1hPct: 0,
            fundingRate8hPct: 0,
            fundingAprPct: 0,
            openInterestUsd: item.oiUsd,
          };
        }
      })
    );

    return fundingEntries;
  }

  public async fetchCandles(
    instId: string,
    interval: '15m' | '1h' | '4h' | '1d',
    limit = 120
  ): Promise<OhlcvCandle[]> {
    const bar = OKX_BAR_MAP[interval];
    const safeLimit = Math.min(300, Math.max(20, limit));
    const resp = await safeUpstreamFetchJson<OkxEnvelope<string[]>>(
      `${OKX_BASE}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${safeLimit}`,
      { method: 'GET' },
      this.timeoutMs,
      this.fetchImpl
    );

    if (!resp || resp.code !== '0' || !Array.isArray(resp.data) || resp.data.length === 0) {
      throw new UpstreamError(
        'SYMBOL_NOT_FOUND',
        `OKX Swap returned zero candles for "${instId}" (${bar}).`,
        404,
        false
      );
    }

    return resp.data
      .map((row) => ({
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
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
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
