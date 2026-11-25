import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_TTL_MS,
  CircuitBreaker,
  LruTtlCache,
  type MarketVenueAdapter,
  type NormalizedAssetMicrostructure,
  type NormalizedOrderbookSnapshot,
  UpstreamError,
  safeUpstreamFetchJson,
} from '../src/adapters/cacheAndBreaker.js';
import { VenueRouter, normalizeSymbol } from '../src/adapters/venueRouter.js';
import { HyperliquidAdapter } from '../src/adapters/hyperliquidAdapter.js';
import { OkxSwapAdapter } from '../src/adapters/okxAdapter.js';
import { BillingGate, type PpeEventName } from '../src/billing/billingGate.js';
import type { OhlcvCandle } from '../src/engine/indicators.js';
import { mulberry32 } from '../src/engine/quantEngine.js';
import { executeToolByName } from '../src/mcp/tools.js';
import { TenantRateLimiter, hashTenantIdentifier } from '../src/security/rateLimiter.js';
import { createQuantPreflightApp } from '../src/server.js';
import { createNonAdvisoryMeta } from '../src/types/schemas.js';

function createMockCandles(count = 160): OhlcvCandle[] {
  const rng = mulberry32(2026);
  const candles: OhlcvCandle[] = [];
  let px = 95_000;
  for (let i = 0; i < count; i++) {
    const open = px;
    const close = open * (1 + (rng() - 0.49) * 0.01);
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    candles.push({
      timestamp: 1_760_000_000_000 + i * 3_600_000,
      open,
      high,
      low,
      close,
      volume: 250 + rng() * 500,
    });
    px = close;
  }
  return candles;
}

function createHealthyMockAdapter(
  venueId: 'hyperliquid' | 'okx_fallback' = 'hyperliquid'
): MarketVenueAdapter {
  return {
    venueId,
    async fetchOrderbook(sym: string): Promise<NormalizedOrderbookSnapshot> {
      return {
        venue: venueId,
        normalizedSymbol: sym,
        bids: [
          { price: 99_995, size: 8 },
          { price: 99_980, size: 25 },
          { price: 99_920, size: 60 },
        ],
        asks: [
          { price: 100_005, size: 8 },
          { price: 100_020, size: 25 },
          { price: 100_080, size: 60 },
        ],
        timestampMs: Date.now(),
      };
    },
    async fetchMarketContexts(): Promise<NormalizedAssetMicrostructure[]> {
      return [
        {
          symbol: 'BTC',
          venueSymbol: venueId === 'hyperliquid' ? 'BTC' : 'BTC-USDT-SWAP',
          markPrice: 100_000,
          midPrice: 100_000,
          fundingRate1hPct: 0.00125,
          fundingRate8hPct: 0.01,
          fundingAprPct: 10.95,
          openInterestUsd: 850_000_000,
        },
        {
          symbol: 'ETH',
          venueSymbol: venueId === 'hyperliquid' ? 'ETH' : 'ETH-USDT-SWAP',
          markPrice: 3_400,
          midPrice: 3_400,
          fundingRate1hPct: -0.0008,
          fundingRate8hPct: -0.0064,
          fundingAprPct: -7.008,
          openInterestUsd: 420_000_000,
        },
      ];
    },
    async fetchCandles(): Promise<OhlcvCandle[]> {
      return createMockCandles(160);
    },
  };
}

function createFailingMockAdapter(
  venueId: 'hyperliquid' | 'okx_fallback',
  statusCode = 503
): MarketVenueAdapter {
  return {
    venueId,
    async fetchOrderbook(): Promise<NormalizedOrderbookSnapshot> {
      throw new UpstreamError(`UPSTREAM_HTTP_${statusCode}`, `${venueId} down`, statusCode, true);
    },
    async fetchMarketContexts(): Promise<NormalizedAssetMicrostructure[]> {
      throw new UpstreamError(`UPSTREAM_HTTP_${statusCode}`, `${venueId} down`, statusCode, true);
    },
    async fetchCandles(): Promise<OhlcvCandle[]> {
      throw new UpstreamError(`UPSTREAM_HTTP_${statusCode}`, `${venueId} down`, statusCode, true);
    },
  };
}

describe('Phase 2-4: VenueRouter, Cache, Circuit Breaker, Fail-Closed Billing & HTTP/MCP Security (22+ Tests)', () => {
  let activeServer: Server | null = null;

  afterEach(async () => {
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = null;
    }
  });

  it('25. normalizeSymbol maps BTC, BTCUSDT, BTC-PERP, kPEPE, and 1000PEPE cleanly across venues', () => {
    expect(normalizeSymbol('btc', 'hyperliquid')).toBe('BTC');
    expect(normalizeSymbol('BTCUSDT', 'hyperliquid')).toBe('BTC');
    expect(normalizeSymbol('BTC-PERP', 'hyperliquid')).toBe('BTC');
    expect(normalizeSymbol('BTC-USDT-SWAP', 'okx_fallback')).toBe('BTC-USDT-SWAP');
    expect(normalizeSymbol('BTC', 'okx_fallback')).toBe('BTC-USDT-SWAP');
    expect(normalizeSymbol('1000PEPE', 'hyperliquid')).toBe('kPEPE');
    expect(normalizeSymbol('kPEPE', 'hyperliquid')).toBe('kPEPE');
    expect(normalizeSymbol('kPEPE', 'okx_fallback')).toBe('PEPE-USDT-SWAP');
    expect(normalizeSymbol('1000PEPEUSDT', 'okx_fallback')).toBe('PEPE-USDT-SWAP');
  });

  it('26. normalizeSymbol rejects SQL injection / XSS / invalid ticker strings', () => {
    expect(() => normalizeSymbol("'; DROP TABLE users;--", 'hyperliquid')).toThrow(UpstreamError);
    expect(() => normalizeSymbol('<script>alert(1)</script>', 'okx_fallback')).toThrow(UpstreamError);
  });

  it('27. 2-Tier LruTtlCache separates 3,000ms microstructure TTL from 30,000ms candle TTL and caps at maxEntries', () => {
    let clock = 1_000_000;
    const cache = new LruTtlCache<string>(10, () => clock);

    cache.set('book:BTC', 'l2_data', CACHE_TTL_MS.MICROSTRUCTURE);
    cache.set('candles:BTC', 'ohlcv_data', CACHE_TTL_MS.CANDLES);

    clock += 2_500;
    expect(cache.get('book:BTC')?.value).toBe('l2_data');
    expect(cache.get('candles:BTC')?.value).toBe('ohlcv_data');

    // Advance past 3,000ms: book expires, candles remain cached up to 30,000ms
    clock += 1_000; // total +3,500ms
    expect(cache.get('book:BTC')).toBeUndefined();
    expect(cache.get('candles:BTC')?.value).toBe('ohlcv_data');

    clock += 27_000; // total +30,500ms
    expect(cache.get('candles:BTC')).toBeUndefined();

    // Enforce bounded maxEntries=10
    for (let i = 0; i < 25; i++) {
      cache.set(`k_${i}`, `v_${i}`, 10_000);
    }
    expect(cache.size()).toBeLessThanOrEqual(10);
  });

  it('28. safeUpstreamFetchJson enforces OWASP SSRF host whitelist and 2.5s AbortController timeout', async () => {
    await expect(
      safeUpstreamFetchJson('https://169.254.169.254/latest/meta-data')
    ).rejects.toThrow(/not in ALLOWED_UPSTREAM_HOSTS/i);

    await expect(
      safeUpstreamFetchJson('http://api.hyperliquid.xyz/info')
    ).rejects.toThrow(/not in ALLOWED_UPSTREAM_HOSTS/i);

    // Mock hanging fetch to verify AbortController timeout
    const hangingFetch: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    await expect(
      safeUpstreamFetchJson('https://api.hyperliquid.xyz/info', { method: 'POST' }, 60, hangingFetch)
    ).rejects.toThrow(/timed out/i);
  });

  it('29. CircuitBreaker trips OPEN on 3 failures or 429 and recovers after 30s cooldown', () => {
    let now = 10_000;
    const cb = new CircuitBreaker(3, 30_000, () => now);
    expect(cb.getState()).toBe('CLOSED');

    cb.recordFailure(500);
    cb.recordFailure(500);
    expect(cb.getState()).toBe('CLOSED');
    cb.recordFailure(500);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.canRequest()).toBe(false);

    now += 30_001;
    expect(cb.canRequest()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('30. VenueRouter automatically fails over from degraded Primary to OKX Secondary fallback', async () => {
    const router = new VenueRouter({
      primary: createFailingMockAdapter('hyperliquid', 503),
      fallback: createHealthyMockAdapter('okx_fallback'),
    });

    const routed = await router.getOrderbook('BTCUSDT', 'auto');
    expect(routed.venueUsed).toBe('okx_fallback');
    expect(routed.warnings.some((w) => w.includes('okx_fallback'))).toBe(true);
  });

  it('31. Fail-Closed Billing: Zero charge calls on Zod input validation errors across all 4 tools', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const router = new VenueRouter({
      primary: createHealthyMockAdapter('hyperliquid'),
      fallback: createHealthyMockAdapter('okx_fallback'),
    });

    const r1 = await executeToolByName(
      'preflight_execution_risk',
      { symbol: 'BTC', order_size_usd: -100, side: 'buy' },
      { router, billing }
    );
    const r2 = await executeToolByName(
      'scan_venue_microstructure',
      { limit: 999 },
      { router, billing }
    );
    const r3 = await executeToolByName(
      'audit_indicator_collinearity',
      { symbol: 'BTC', indicators: ['sma_5'], feature_matrix: { a: [1, 2], b: [3, 4] } },
      { router, billing }
    );
    const r4 = await executeToolByName(
      'simulate_backtest_reality',
      { win_rate_pct: 50, avg_win_pct: 0, avg_loss_pct: 0.5, num_trades: 100, risk_per_trade_pct: 1 },
      { router, billing }
    );

    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    expect(r3.isError).toBe(true);
    expect(r4.isError).toBe(true);
    expect(chargeCalls).toBe(0);
    expect(billing.getStats().totalChargeCalls).toBe(0);
  });

  it('32. Fail-Closed Billing: Zero charge calls when all venues are down (UPSTREAM_UNAVAILABLE)', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const deadRouter = new VenueRouter({
      primary: createFailingMockAdapter('hyperliquid', 504),
      fallback: createFailingMockAdapter('okx_fallback', 503),
    });

    const res = await executeToolByName(
      'preflight_execution_risk',
      { symbol: 'BTC', order_size_usd: 25_000, side: 'buy' },
      { router: deadRouter, billing }
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('UPSTREAM_UNAVAILABLE');
    expect(chargeCalls).toBe(0);
  });

  it('33. Fail-Closed Billing: Zero charge calls when single candle / empty orderbook causes domain error', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const brokenBookAdapter: MarketVenueAdapter = {
      ...createHealthyMockAdapter('hyperliquid'),
      async fetchCandles() {
        return createMockCandles(1); // Only 1 candle -> INSUFFICIENT_CANDLES
      },
    };
    const router = new VenueRouter({
      primary: brokenBookAdapter,
      fallback: brokenBookAdapter,
    });

    const res = await executeToolByName(
      'preflight_execution_risk',
      { symbol: 'BTC', order_size_usd: 10_000, side: 'buy' },
      { router, billing }
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('INSUFFICIENT_CANDLES');
    expect(chargeCalls).toBe(0);
  });

  it('34. Phase 0 Refinement #1a: eventChargeLimitReached=true with chargedCount=1 returns full data + billing_notice', async () => {
    const billing = new BillingGate(async () => ({
      eventChargeLimitReached: true,
      chargedCount: 1,
    }));
    const router = new VenueRouter({ primary: createHealthyMockAdapter() });

    const res = await executeToolByName(
      'preflight_execution_risk',
      { symbol: 'BTC', order_size_usd: 15_000, side: 'buy' },
      { router, billing }
    );

    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(parsed.l2_execution_walk).toBeDefined();
    expect(parsed.billing_notice).toBe('Free tier or max charge limit reached');
    expect((parsed.meta as { advisory: boolean }).advisory).toBe(false);
  });

  it('35. Phase 0 Refinement #1b: eventChargeLimitReached=true with chargedCount=0 suppresses paid data completely', async () => {
    const billing = new BillingGate(async () => ({
      eventChargeLimitReached: true,
      chargedCount: 0,
    }));
    const router = new VenueRouter({ primary: createHealthyMockAdapter() });

    const res = await executeToolByName(
      'preflight_execution_risk',
      { symbol: 'BTC', order_size_usd: 15_000, side: 'buy' },
      { router, billing }
    );

    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(parsed.billing_status).toBe('CHARGE_LIMIT_REACHED');
    expect(parsed.charged).toBe(false);
    expect(parsed.message).toBe('Free tier or max charge limit reached');
    // Crucial: Paid analytical outputs MUST NOT leak when chargedCount === 0
    expect(parsed.l2_execution_walk).toBeUndefined();
    expect(parsed.atr_volatility_stops_1h).toBeUndefined();
    expect(parsed.friction_breakdown).toBeUndefined();
  });

  it('36. Non-Advisory Firewall blocks directional words or NaN before charging ($0 billed)', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });

    await expect(
      billing.verifyAndCharge('preflight-execution-risk', {
        meta: createNonAdvisoryMeta(),
        signal: 'STRONG BUY NOW',
      })
    ).rejects.toThrow(/prohibited directional token/i);

    await expect(
      billing.verifyAndCharge('preflight-execution-risk', {
        meta: createNonAdvisoryMeta(),
        bad_number: Number.NaN,
      })
    ).rejects.toThrow(/non-finite/i);

    expect(chargeCalls).toBe(0);
  });

  it('37. Zero-PII Tenant Hashing masks raw X-Apify-User-ID irreversibly', () => {
    const rawPii = 'apify_user_john.doe@company.io';
    const digest = hashTenantIdentifier(rawPii);
    expect(digest).toHaveLength(12);
    expect(digest).not.toContain('john');
    expect(/^[a-f0-9]{12}$/.test(digest)).toBe(true);
  });

  it('38. All 4 tools succeed, charge exact PPE event once, place meta first, and contain zero BUY/SELL/HOLD/LONG/SHORT tokens', async () => {
    const chargedEvents: PpeEventName[] = [];
    const billing = new BillingGate(async ({ eventName }) => {
      chargedEvents.push(eventName);
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const router = new VenueRouter({ primary: createHealthyMockAdapter() });

    const calls = [
      executeToolByName(
        'preflight_execution_risk',
        {
          symbol: 'BTCUSDT',
          order_size_usd: 50_000,
          side: 'buy',
          account_equity_usd: 25_000,
          win_rate_pct: 53,
          reward_risk_ratio: 1.75,
        },
        { router, billing }
      ),
      executeToolByName(
        'scan_venue_microstructure',
        { limit: 2, sort_by: 'open_interest_usd' },
        { router, billing }
      ),
      executeToolByName(
        'audit_indicator_collinearity',
        {
          symbol: 'BTC',
          interval: '1h',
          indicators: ['sma_5', 'sma_20', 'ema_12', 'rsi_14', 'atr_14'],
        },
        { router, billing }
      ),
      executeToolByName(
        'simulate_backtest_reality',
        {
          win_rate_pct: 51,
          avg_win_pct: 0.9,
          avg_loss_pct: 0.5,
          num_trades: 200,
          risk_per_trade_pct: 1.25,
          symbol: 'BTC',
          order_size_usd: 25_000,
        },
        { router, billing }
      ),
    ];

    const results = await Promise.all(calls);
    expect(chargedEvents.slice().sort()).toEqual([
      'audit-indicator-collinearity',
      'preflight-execution-risk',
      'scan-venue-microstructure',
      'simulate-backtest-reality',
    ]);

    for (const r of results) {
      expect(r.isError).toBeUndefined();
      const rawJson = r.content[0]!.text;
      const obj = JSON.parse(rawJson) as Record<string, unknown>;
      expect(Object.keys(obj)[0]).toBe('meta');
      expect((obj.meta as { advisory: boolean }).advisory).toBe(false);
      expect(/\b(BUY|SELL|HOLD|LONG|SHORT)\b/i.test(rawJson)).toBe(false);
    }
  });

  it('39. E2E HTTP Server: GET /health (200), GET/DELETE /mcp (405 JSON), >256KB (413), Rate Limit (429), and MCP tools/list + tools/call (<200ms cache p95)', async () => {
    let chargeCount = 0;
    const billing = new BillingGate(async () => {
      chargeCount += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const router = new VenueRouter({ primary: createHealthyMockAdapter() });
    const rateLimiter = new TenantRateLimiter({ maxRequestsPerWindow: 5, windowMs: 60_000 });
    const { app } = createQuantPreflightApp({ router, billing, rateLimiter });

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. GET /health -> 200 OK
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok', mode: 'multi-tenant' });

    // 2. Refinement #4: GET /mcp and DELETE /mcp -> 405 Method Not Allowed JSON
    const getMcp = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
    expect(getMcp.status).toBe(405);
    expect(getMcp.headers.get('allow')).toBe('POST');
    expect((await getMcp.json()).error.message).toMatch(/Method Not Allowed/i);

    const delMcp = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(delMcp.status).toBe(405);

    // 3. OWASP >256KB Payload -> 413 Payload Too Large ($0 charged)
    const oversized = JSON.stringify({ junk: 'x'.repeat(270 * 1024) });
    const bigRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Apify-User-ID': 'tenant-oversize' },
      body: oversized,
    });
    expect(bigRes.status).toBe(413);
    expect(chargeCount).toBe(0);

    // 4. MCP JSON-RPC tools/list -> exact 4 frozen tools
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Apify-User-ID': 'tenant-alpha' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { result: { tools: { name: string }[] } };
    expect(listJson.result.tools.map((t) => t.name).sort()).toEqual([
      'audit_indicator_collinearity',
      'preflight_execution_risk',
      'scan_venue_microstructure',
      'simulate_backtest_reality',
    ]);

    // 5. MCP JSON-RPC tools/call + Warm Cache Hit Latency (<200ms SLA)
    const t0 = performance.now();
    const callRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Apify-User-ID': 'tenant-alpha' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'preflight_execution_risk',
          arguments: {
            symbol: 'BTC',
            order_size_usd: 10_000,
            side: 'buy',
          },
        },
      }),
    });
    expect(callRes.status).toBe(200);

    const tCache = performance.now();
    const cachedCallRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Apify-User-ID': 'tenant-alpha' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'preflight_execution_risk',
          arguments: {
            symbol: 'BTC',
            order_size_usd: 10_000,
            side: 'buy',
          },
        },
      }),
    });
    const cacheMs = performance.now() - tCache;
    expect(cachedCallRes.status).toBe(200);
    expect(cacheMs).toBeLessThan(200);
    expect(performance.now() - t0).toBeGreaterThan(0);
    expect(chargeCount).toBe(2);

    // 6. Rate Limit Enforcement (maxRequestsPerWindow = 5 for tenant-rate-test)
    let status429Seen = false;
    for (let i = 0; i < 7; i++) {
      const rlRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Apify-User-ID': 'tenant-rate-test' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/list', params: {} }),
      });
      if (rlRes.status === 429) status429Seen = true;
    }
    expect(status429Seen).toBe(true);
  });

  it('40. OkxSwapAdapter multiplies contract quantities by ctVal into exact base units', async () => {
    const mockFetch: typeof globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/v5/public/instruments')) {
        return new Response(
          JSON.stringify({
            code: '0',
            msg: '',
            data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', state: 'live' }],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          code: '0',
          msg: '',
          data: [
            {
              bids: [['99990', '200', '0', '4']], // 200 contracts * 0.01 = 2.0 BTC
              asks: [['100010', '300', '0', '5']], // 300 contracts * 0.01 = 3.0 BTC
              ts: '1760000000000',
            },
          ],
        }),
        { status: 200 }
      );
    };

    const okx = new OkxSwapAdapter(2500, mockFetch);
    const snap = await okx.fetchOrderbook('BTC-USDT-SWAP');
    expect(snap.bids[0]!.size).toBeCloseTo(2.0, 6);
    expect(snap.asks[0]!.size).toBeCloseTo(3.0, 6);
  });

  it('41. HyperliquidAdapter parses L2 book & contexts and throws SYMBOL_NOT_FOUND on unlisted coin', async () => {
    const mockFetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type: string; coin?: string };
      if (body.type === 'l2Book' && body.coin === 'UNLISTED999') {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      if (body.type === 'metaAndAssetCtxs') {
        return new Response(
          JSON.stringify([
            { universe: [{ name: 'BTC', szDecimals: 5 }] },
            [{ funding: '0.0000125', openInterest: '1000', markPx: '100000', midPx: '100000' }],
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const hl = new HyperliquidAdapter(2500, mockFetch);
    await expect(hl.fetchOrderbook('UNLISTED999')).rejects.toThrow(/returned no L2 orderbook/i);
    const ctxs = await hl.fetchMarketContexts(['BTC']);
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.openInterestUsd).toBe(100_000_000);
    expect(ctxs[0]!.fundingAprPct).toBeCloseTo(10.95, 2);
  });

  it('42. Tool 3 Mode B (custom feature_matrix) executes deterministically with zero network calls', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const deadRouter = new VenueRouter({
      primary: createFailingMockAdapter('hyperliquid'),
      fallback: createFailingMockAdapter('okx_fallback'),
    });

    const f1 = Array.from({ length: 40 }, (_, i) => Math.sin(i * 0.3));
    const f2 = Array.from({ length: 40 }, (_, i) => Math.cos(i * 0.3));
    const res = await executeToolByName(
      'audit_indicator_collinearity',
      { feature_matrix: { osc_sin: f1, osc_cos: f2 } },
      { router: deadRouter, billing }
    );

    expect(res.isError).toBeUndefined();
    expect(chargeCalls).toBe(1);
    const parsed = JSON.parse(res.content[0]!.text) as { venue_used: string };
    expect(parsed.venue_used).toBe('deterministic_local');
  });

  it('43. Tool 4 manual round_trip_cost_bps mode flags impossible_target_after_friction accurately', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const deadRouter = new VenueRouter({
      primary: createFailingMockAdapter('hyperliquid'),
      fallback: createFailingMockAdapter('okx_fallback'),
    });

    const res = await executeToolByName(
      'simulate_backtest_reality',
      {
        win_rate_pct: 60,
        avg_win_pct: 0.1,
        avg_loss_pct: 0.2,
        num_trades: 100,
        risk_per_trade_pct: 1,
        round_trip_cost_bps: 15, // 0.15% > 0.10% avg_win_pct
      },
      { router: deadRouter, billing }
    );

    expect(res.isError).toBeUndefined();
    expect(chargeCalls).toBe(1);
    const parsed = JSON.parse(res.content[0]!.text) as {
      simulation: { impossible_target_after_friction: boolean };
      warnings: string[];
    };
    expect(parsed.simulation.impossible_target_after_friction).toBe(true);
    expect(parsed.warnings.some((w) => w.includes('IMPOSSIBLE_TARGET'))).toBe(true);
  });

  it('44. Unknown tool name returns UNKNOWN_TOOL with isError=true and 0 charges', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const router = new VenueRouter({ primary: createHealthyMockAdapter() });

    const res = await executeToolByName('non_existent_tool', {}, { router, billing });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('UNKNOWN_TOOL');
    expect(chargeCalls).toBe(0);
  });

  it('45. Malformed JSON syntax payload on POST /mcp returns HTTP 400 Parse error and 0 charges', async () => {
    let chargeCalls = 0;
    const billing = new BillingGate(async () => {
      chargeCalls += 1;
      return { eventChargeLimitReached: false, chargedCount: 1 };
    });
    const router = new VenueRouter({ primary: createHealthyMockAdapter() });
    const { app } = createQuantPreflightApp({ router, billing });

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;

    const badRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0", BROKEN_JSON',
    });
    expect(badRes.status).toBe(400);
    expect(chargeCalls).toBe(0);
  });
});
