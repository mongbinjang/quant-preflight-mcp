# QuantPreflight & Strategy-Audit MCP (`quant-preflight-mcp`)

> **Stop Letting AI Agents Guess Orderbook Slippage, Overbet Kelly Fractions, and Stack Redundant Indicators.**  
> Real-time L2 VWAP book-walk execution drag, cross-venue perpetual microstructure, Ridge-stabilized VIF + Modified Gram-Schmidt feature orthogonalization, and 5,000-path Monte Carlo ruin audits — delivered via **Stateless MCP** at **$0.008–$0.025 per verified call** instead of **$379/month** institutional data terminals.

---

## Fold 1 — 5-Second Value Proposition & 4 Frozen Tools

Autonomous trading bots and AI coding assistants (Claude, Cursor, ChatGPT) routinely hallucinate execution assumptions: they assume 0 bps market impact on $250,000 orders, apply frictionless textbook Kelly formulas, combine 8 collinear momentum oscillators (`VIF > 25`), and ignore consecutive losing-streak math.

**QuantPreflight MCP** gives any MCP-compatible AI agent deterministic, zero-hallucination quantitative pre-trade and strategy-audit tools backed by live public L2 orderbooks (**Hyperliquid Primary + OKX Swap v5 Automatic Failover**) with **zero API keys**, **zero residential proxy cost**, and **Fail-Closed Billing (`$0.00` charged on any error)**.

| MCP Tool (`verb_noun`) | Primary Use Case | Upstream I/O | PPE Price | Calls in $5 Apify Free Credit |
| :--- | :--- | :--- | :---: | :---: |
| `preflight_execution_risk` | Live L2 VWAP slippage (bps/$), fee + funding drag, 14-period Wilder ATR stops, breakeven win-rate penalty, and Half-Kelly sizing | Live L2 + 1H Candles (`3s`/`30s` cache) | **$0.008** | **625 calls / mo** |
| `scan_venue_microstructure` | Normalized annualized funding APR%, open interest (USD), top spread (bps), and $10k/$100k L2 impact across top perpetual pairs | Live Contexts + L2 Depth (`3s` cache) | **$0.010** | **500 calls / mo** |
| `audit_indicator_collinearity` | Detect indicator overfitting via Ridge VIF, Jacobi SVD Condition Number, Effective Rank, and 2-pass Modified Gram-Schmidt orthogonal weights | Mode A: Live OHLCV · Mode B: Pure CPU | **$0.025** | **200 calls / mo** |
| `simulate_backtest_reality` | Inject realistic or live L2 friction into backtest stats across 5,000 seeded Mulberry32 Monte Carlo paths + exact Markov losing-streak DP | Optional Live L2 or Pure CPU | **$0.025** | **200 calls / mo** |

**Cost Anchor**: Institutional derivatives microstructure dashboards charge **$379/month ($4,548/year)** regardless of usage. With `quant-preflight-mcp`, 100 live pre-trade L2 checks cost **$0.80 total** — covered 100% inside Apify's free monthly starter credit.

---

## Fold 2 — One-Click MCP Connection Snippets (Claude · Cursor · ChatGPT)

### A. Connect via Apify Hosted Standby MCP (`mcp.apify.com` / Actor Standby URL)
Add the following block to `claude_desktop_config.json` (Claude Desktop) or `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "quant-preflight": {
      "url": "https://YOUR-USERNAME--quant-preflight-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_APIFY_API_TOKEN"
      }
    }
  }
}
```

### B. Connect via Local / Self-Hosted Stateless HTTP (`MCPize` Compatible)
```bash
LOCAL_STANDALONE=true PORT=3000 npm start
# Readiness probe: GET http://localhost:3000/health -> {"status":"ok","mode":"multi-tenant"}
# Stateless MCP endpoint: POST http://localhost:3000/mcp
```

---

## Fold 3 — LLM Hallucination vs. `quant-preflight-mcp` Verified JSON

| Prompt Asked to AI Agent | Typical Unassisted LLM Hallucination | `quant-preflight-mcp` Deterministic Output |
| :--- | :--- | :--- |
| *"Check execution drag for a $250,000 SOL market order with 52% win rate and 1.6 R:R."* | *"Slippage on SOL is usually ~1–2 bps. Using standard Kelly `p - q/b = 22%`, Half-Kelly is 11%."* *(Dangerous overbet + guessed liquidity)* | Walks live L2 levels: measures exact `vwap_execution_price`, `slippage_vs_mid_bps`, `insufficient_book_depth` flag, 14-period Wilder ATR 1.5x/2.0x/3.0x stops, exact breakeven jump `ΔW`, and friction-adjusted Half-Kelly haircut. |
| *"Are SMA(20), EMA(12), Bollinger Middle, and RSI(14) independent features?"* | *"Yes, mixing trend and momentum gives diverse confirmation!"* *(Ignores exact linear redundancy between SMA(20) and BB Middle)* | Computes exact sample correlation `r = 1.000000`, `condition_number = 1e12` (`CRITICAL`), flags redundant pairs `|r| > 0.85`, and outputs 2-pass Modified Gram-Schmidt `orthogonal_weights` (`max_off_diagonal_dot < 1e-14`). |

### Example Verified Response (`preflight_execution_risk`)
```json
{
  "meta": {
    "advisory": false,
    "data_type": "derived_quantitative_analytics",
    "disclaimer": "Deterministic mathematical calculation for educational and risk-simulation purposes only. Not financial or investment advice."
  },
  "tool": "preflight_execution_risk",
  "asset_symbol": "BTC",
  "venue_used": "hyperliquid",
  "data_freshness_ms": 0,
  "l2_execution_walk": {
    "book_side_swept": "asks",
    "mid_price": 100000,
    "top_spread_bps": 1,
    "requested_order_usd": 50000,
    "filled_order_usd": 50000,
    "insufficient_book_depth": false,
    "vwap_execution_price": 100005,
    "slippage_vs_mid_bps": 0.5
  },
  "friction_breakdown": {
    "round_trip_taker_fee_bps": 7,
    "round_trip_slippage_bps": 1,
    "estimated_funding_drag_bps": 0.125,
    "total_round_trip_friction_bps": 8.125
  }
}
```

---

## Fold 4 — Transparent Pay-Per-Event Pricing & Fail-Closed `$0` Error Guarantee

| Billing Event ID | Triggered By Tool | Event Price (USD) | Recommended `minimalMaxTotalChargeUsd` |
| :--- | :--- | :---: | :---: |
| `preflight-execution-risk` | `preflight_execution_risk` | `$0.008` | `$0.05` |
| `scan-venue-microstructure` | `scan_venue_microstructure` | `$0.010` | `$0.05` |
| `audit-indicator-collinearity` | `audit_indicator_collinearity` | `$0.025` | `$0.05` |
| `simulate-backtest-reality` | `simulate_backtest_reality` | `$0.025` | `$0.05` |

### Strict Fail-Closed Billing Guarantee (`$0` on Error)
1. **Validation First**: Malformed parameters, oversized payloads (`>256KB`), unsupported HTTP methods (`405`), or rate-limited bursts (`429`) are rejected at the ingress boundary with **`$0.00` billed**.
2. **Upstream Resilience**: If Primary (`Hyperliquid`) times out (`>2,500ms`) or trips its 3-strike circuit breaker, `VenueRouter` automatically fails over to Secondary (`OKX Swap v5`). If *all* venues are unreachable, the server returns `{ isError: true, code: "UPSTREAM_UNAVAILABLE" }` with **`0` calls to `Actor.charge()`**.
3. **Graceful Spend-Cap Protection**: If your Apify Free tier or `maxTotalChargeUsd` ceiling is reached (`eventChargeLimitReached: true`), the server exits cleanly with a structured JSON notice instead of throwing unhandled runtime exceptions.

---

## Fold 5 — Deterministic Mathematical Specifications & Latency SLAs

1. **L2 Orderbook VWAP Book-Walk**: Sweeps sorted resting levels $(p_i, q_i)$ up to notional $N_{\text{req}}$, computing $\text{VWAP} = \frac{\sum \Delta u_i}{\sum (\Delta u_i / p_i)}$ and $\text{Slippage}_{\text{bps}} = \frac{|\text{VWAP} - P_{\text{mid}}|}{P_{\text{mid}}} \times 10^4$.
2. **14-Period Wilder ATR**: $TR_t = \max(H_t - L_t, |H_t - C_{t-1}|, |L_t - C_{t-1}|)$ smoothed via $ATR_t = \frac{13 \cdot ATR_{t-1} + TR_t}{14}$, outputting `1.5x`, `2.0x`, and `3.0x` volatility distances and fee-adjusted `1R` notional limits.
3. **Ridge VIF, Jacobi Eigenvalues & 2-Pass Modified Gram-Schmidt**:
   - Excludes zero-variance constant columns ($\sigma < 10^{-12}$) prior to Z-scoring.
   - Computes $\text{VIF}_j = [(R + 10^{-10}I)^{-1}]_{jj}$ via Gauss-Jordan partial pivoting and spectral Condition Number $\kappa(R) = \min(10^{12}, \lambda_{\max} / \lambda_{\min})$ + Shannon Effective Rank $\exp(-\sum p_i \ln p_i)$.
   - Applies Kahan 2-pass Modified Gram-Schmidt re-orthogonalization guaranteeing `max_off_diagonal_dot < 1e-9` (`~1e-15` typical).
4. **Friction-Adjusted Kelly & 5,000-Path Seeded Monte Carlo**:
   - Solves $f^* = \max\left(0, \frac{p}{1 + c_R} - \frac{1 - p}{B - c_R}\right)$ where $c_R = \frac{C_{\text{rt}}}{SL}$, alongside 5,000 seeded 32-bit `Mulberry32` multiplicative equity paths and exact $(k+1)$-state absorbing Markov chain streak probabilities for $k \in \{4, 6, 8, 10, 12\}$.

| Execution Path | Target SLA | Architecture Enabler |
| :--- | :---: | :--- |
| Pure CPU Analytics (Mode B Collinearity & 5,000-Path MC) | **`< 50 ms`** | Inlined `Mulberry32` integer PRNG + `Float64Array` native sort |
| Warm Cache Microstructure Call (`p95`) | **`< 200 ms`** | Bounded 2-tier `LruTtlCache` (`3,000ms` L2/OI · `30,000ms` OHLCV) |
| Cold Live Upstream L2 Call (`p95`) | **`< 500 ms`** | Direct JSON REST (`0` proxy hops) + `2,500ms` `AbortController` |

---

## Fold 6 — 60-Second Verification Checklist & Non-Advisory Regulatory Firewall

### Quick Local Smoke Test (60 Seconds)
```bash
npm install
npm run typecheck          # Strict tsc --noEmit (0 errors)
npm test                   # 45+ Vitest boundary, security, SLA & fail-closed billing tests
npm run build              # Compile ESM production bundle into dist/
LOCAL_STANDALONE=true npm start
```

### Strict Non-Advisory & Zero-PII Compliance Notice
- **Zero PII**: `quant-preflight-mcp` never requests, logs, or stores names, emails, wallet addresses, or exchange API keys. Multi-tenant `X-Apify-User-ID` headers are hashed in volatile memory (`SHA-256` 12-char digest) solely for `60 req/min` sliding-window rate limiting.
- **Non-Advisory Firewall**: Every response enforces `"advisory": false` and strips directional trading recommendations. Outputs are strictly deterministic mathematical and market-microstructure computations for educational, research, and pre-trade risk-simulation use only, and do not constitute financial or investment advice.
