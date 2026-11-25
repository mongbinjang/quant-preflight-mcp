# 🚀 Track B Deployment, Staging Verification & Operations Runbook (`quant-preflight-mcp`)

## 1. Pre-Deploy Local Verification Commands
```powershell
cd "c:\Users\monke\OneDrive\Desktop\쉽게설명해주는사람\track-b-quant-preflight-mcp"
npm.cmd run typecheck     # Must exit 0
npm.cmd test              # Must pass all 45+ unit, security, SLA & zero-charge-on-error tests
npm.cmd run build         # Emits clean production JS to dist/
```

---

## 2. Apify CLI Push & Console Standby Configuration

### 2-1. Push Private Staging Build via Apify CLI
```powershell
npx apify-cli login
npx apify-cli push
```

### 2-2. Configure Apify Console Settings (Before Making Actor Public)
1. **Standby Mode (`Actor -> Settings -> Standby`)**:
   - Confirm **Enable Standby mode** is checked (`usesStandbyMode: true` in `.actor/actor.json`).
   - **Memory**: `256 MB` or `512 MB` (stateless architecture stays well under `150 MB` RSS).
   - **Idle Timeout**: `120` to `180` seconds.
   - **Web Server MCP Path**: `/mcp` · **Readiness Probe Path**: `/health`.
2. **Pay-Per-Event Monetization (`Actor -> Monetization -> Pay per event`)**:
   - Import or verify the 4 events from `.actor/pay_per_event.json`:
     - `preflight-execution-risk`: **`$0.008`**
     - `scan-venue-microstructure`: **`$0.010`**
     - `audit-indicator-collinearity`: **`$0.025`**
     - `simulate-backtest-reality`: **`$0.025`**
   - Set **`minimalMaxTotalChargeUsd`** to **`$0.05`** so trial users with tiny budgets can invoke any of the 4 tools immediately without cap friction.

---

## 3. Mandatory Post-Push Cloud Region HTTP 200 Verification (Phase 0 Refinement #3)

> **CRITICAL ASSUMPTION CHECK**: Local machine IPs differ from Apify Cloud AWS (`us-east-1` / `eu-central-1`) datacenter IPs. Immediately after pushing as a **Private** Actor, run these 3 live checks against your Apify Standby URL (`https://<USERNAME>--quant-preflight-mcp.apify.actor`) **before** publishing to the Apify Store:

### Step 3-1: Verify Standby Readiness Probe
```bash
curl -i "https://<USERNAME>--quant-preflight-mcp.apify.actor/health" \
  -H "Authorization: Bearer <APIFY_API_TOKEN>"
# Expected: HTTP/2 200 -> {"status":"ok","mode":"multi-tenant"}
```

### Step 3-2: Verify Primary Venue (`hyperliquid`) from Apify Cloud IP
```bash
curl -i -X POST "https://<USERNAME>--quant-preflight-mcp.apify.actor/mcp" \
  -H "Authorization: Bearer <APIFY_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 101,
    "method": "tools/call",
    "params": {
      "name": "preflight_execution_risk",
      "arguments": {
        "symbol": "BTCUSDT",
        "order_size_usd": 25000,
        "side": "buy",
        "venue": "hyperliquid"
      }
    }
  }'
# Expected: HTTP 200, isError absent, "venue_used": "hyperliquid"
```

### Step 3-3: Verify Secondary Fallback Venue (`okx`) from Apify Cloud IP
```bash
curl -i -X POST "https://<USERNAME>--quant-preflight-mcp.apify.actor/mcp" \
  -H "Authorization: Bearer <APIFY_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 102,
    "method": "tools/call",
    "params": {
      "name": "preflight_execution_risk",
      "arguments": {
        "symbol": "BTC-PERP",
        "order_size_usd": 25000,
        "side": "buy",
        "venue": "okx"
      }
    }
  }'
# Expected: HTTP 200, isError absent, "venue_used": "okx_fallback"
```
*If either venue returns HTTP 403/451 from Apify's AWS region, switch the Actor's Standby region (US ↔ EU) in Apify Console or swap the affected secondary adapter behind `MarketVenueAdapter` before public launch.*

---

## 4. MCPize Mirroring Checklist

1. Build container from root `Dockerfile` with environment variables:
   - `LOCAL_STANDALONE=true` (disables `Actor.init()`/`Actor.charge()` so MCPize handles its own gateway billing).
   - `PORT=3000` (automatically read by `src/main.ts`).
2. Configure MCPize health check to `GET /health` (`200 OK`) and MCP Streamable HTTP path to `POST /mcp`.
3. Verify `GET /mcp` returns HTTP `405` JSON (`Allow: POST`) so stateless clients immediately use single-request `POST /mcp` mode.

---

## 5. Objective 30 / 60 / 90-Day Scale or Kill Criteria

| Milestone | Target Metric | Action if Met | Action if Missed (Kill / Pivot Rule) |
| :--- | :--- | :--- | :--- |
| **Day 30** | Apify Store Quality Score **≥ 80**, `0` unhandled runtime crashes, **≥ 15** external trial users | List on official MCP directories (`mcp.so`, Smithery, Cursor directory,MCPize) | Audit tool descriptions & search titles; do **not** add a 5th tool or UI |
| **Day 60** | **≥ 5** repeat paying/credit-consuming active agent tenants or **≥ $25/mo** net PPE run-rate | Publish 2 benchmark notebooks showing LLM slippage error vs. `quant-preflight-mcp` | Freeze feature work at `0 hr/mo` maintenance and launch Actor #2 in adjacent B2B vertical |
| **Day 90** | **≥ $100–$300/mo** combined Apify PPE + MCPize revenue with `< 1 hr/mo` ops | Keep running passively; withdraw via PayPal only when balance **≥ $120** to minimize FX fees | Leave online on zero-fixed-cost Standby (`$0` idle cost) and reallocate 100% dev time |
