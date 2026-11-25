# QuantPreflight & Strategy-Audit MCP (`quant-preflight-mcp`) — 한국어 사용자 설명서

> **AI 에이전트가 호가창 슬리피지를 대충 짐작하거나, 켈리 비중을 과베팅하거나, 중복 보조지표를 겹쳐 쓰는 실수를 막아줍니다.**  
> 실시간 L2 호가창 VWAP 슬리피지, 거래소 펀딩비·유동성 스캔, 보조지표 다중공선성(VIF·Gram-Schmidt) 감사, 5,000경로 몬테카를로 파산 확률 시뮬레이션을 **월 `$379` 유료 터미널 대신 호출당 `$0.008~$0.025` 무상태 MCP**로 제공합니다.

🌐 [English README (영문 공식 문서)](./README.md)

---

## 1. 5초 요약 & 4대 핵심 MCP 툴

**QuantPreflight MCP**는 Claude, Cursor, Antigravity IDE, VS Code Copilot, ChatGPT 및 자동매매 봇이 **거래소 API 키·유료 프록시 없이** 실시간 공개 호가창(**Hyperliquid 주 거래소 + OKX Swap v5 자동 우회**)과 결정론적 수학으로 매매 리스크를 사전 검산하게 해주는 서버입니다. (**오류 발생 시 `$0.00` 무과금 보장**)

| MCP 툴 이름 | 주요 사용 목적 | 데이터 소스 | 건당 요금 | Apify 무료 크레딧(`$5`) 호출 수 |
| :--- | :--- | :--- | :---: | :---: |
| `preflight_execution_risk` | 주문 직전 실시간 L2 VWAP 슬리피지(`bps`/`$`), 수수료·펀딩비 마찰, 14-ATR 손절 폭, 손익분기 승률 변화, Half-Kelly 비중 계산 | 실시간 L2 + 1시간봉 (`3초`/`30초` 캐시) | **`$0.008`** | **월 625회** |
| `scan_venue_microstructure` | 주요 무기한 선물 페어의 연환산 펀딩비(APR%), 미결제약정(OI), 스프레드(`bps`), `$10k`/`$100k` 시장가 충격 깊이 비교 | 실시간 펀딩/OI + L2 깊이 (`3초` 캐시) | **`$0.010`** | **월 500회** |
| `audit_indicator_collinearity` | 보조지표 과적합('1인 20역' 중복) 검사: Ridge VIF, 조건수(Condition Number), 유효 차원, 2-Pass Modified Gram-Schmidt 독립 가중치 산출 | Mode A: 실시간 캔들 · Mode B: 순수 CPU | **`$0.025`** | **월 200회** |
| `simulate_backtest_reality` | 백테스트 승률·손익비에 실제 수수료·슬리피지(또는 라이브 L2 슬리피지)를 주입해 5,000경로 몬테카를로 & 마르코프 연패 확률 검증 | 라이브 L2 선택 또는 순수 CPU | **`$0.025`** | **월 200회** |

---

## 2. AI 에이전트 60초 연결 방법 (코딩 불필요)

최신 **Streamable HTTP (`/mcp`)** 표준을 지원하므로 **Cursor(무료/유료)**, **Antigravity IDE**, **Claude Desktop**, **VS Code(Copilot / Cline / Roo Code)**, **ChatGPT** 어디서나 바로 연결되며, **Apify 콘솔 내 `Input → Start`** 버튼으로도 1회성 실행이 가능합니다.

### 방법 A: Apify Server (MCP) 주소로 연결 (추천)
Apify 콘솔(`Actor → 상단 Server 탭` 또는 `Settings → Server`)에서 확인한 본인 서버 URL을 AI 클라이언트 MCP 설정 파일(`~/.cursor/mcp.json`, `~/.gemini/config/mcp_config.json`, `claude_desktop_config.json`)에 붙여넣으세요:

```json
{
  "mcpServers": {
    "quant-preflight": {
      "url": "https://<내_APIFY_아이디>--quant-preflight-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer <내_APIFY_API_토큰>"
      }
    }
  }
}
```

### 방법 B: 내 PC 로컬 또는 MCPize 독립 실행 (`LOCAL_STANDALONE=true`)
```bash
LOCAL_STANDALONE=true PORT=3000 npm start
# 상태 확인: GET http://localhost:3000/health -> {"status":"ok","mode":"multi-tenant"}
# MCP 엔드포인트: POST http://localhost:3000/mcp
```

---

## 3. 연결 후 바로 복붙해 쓰는 한국어 실전 질문 5가지

1. **진입 전 슬리피지 & ATR 손절폭 확인**
   > `quant-preflight 툴로 비트코인(BTC) 25,000달러 시장가 매수 시 실측 슬리피지, 왕복 비용, 1시간봉 ATR 손절 폭 계산해줘.`
2. **예비 거래소(OKX) 자동 우회 종목 조회 (예: 엔비디아 선물)**
   > `quant-preflight 툴로 NVDAUSDT 10,000달러 매수 기준 현재 호가 스프레드랑 1시간봉 ATR 변동성 확인해줘.`
3. **유동성 & 펀딩비 과열 종목 스캔**
   > `quant-preflight 툴로 연환산 펀딩비(APR%)가 높은 상위 10개 무기한 선물 종목의 스프레드와 $100k 충격을 스캔해줘.`
4. **보조지표 중복(다중공선성) 감사**
   > `quant-preflight 툴로 BTC 1시간봉 기준 sma_5, sma_20, ema_12, rsi_14, bb_upper, atr_14 지표의 VIF와 독립 가중치를 감사해줘.`
5. **5,000경로 백테스트 현실 검증**
   > `quant-preflight 툴로 승률 52%, 평균 익절 0.8%, 평균 손절 0.5%, 1회 리스크 1.5%, 250회 매매 전략에 실시간 BTC 슬리피지를 넣어서 5,000번 파산 확률 돌려줘.`

---

## 4. 투명한 과금 및 오류 시 `$0` 무과금(Fail-Closed) 보장

1. **입력 검증 우선**: 잘못된 파라미터, `256KB` 초과 요청(`413`), 분당 `60회` 초과 요청(`429`), 지원하지 않는 HTTP 메서드(`GET/DELETE /mcp` → `405`)는 진입 단계에서 즉시 차단되며 **`$0.00`이 청구**됩니다.
2. **이중 거래소 자동 복구**: 주 거래소(`Hyperliquid`)가 `2.5초` 타임아웃 또는 연속 3회 오류 시 `30초` 서킷 브레이커가 작동해 예비 거래소(`OKX Swap v5`)로 자동 우회합니다. 모든 거래소가 응답하지 않으면 `Actor.charge()`를 호출하지 않고 **`$0` 무과금 에러**를 반환합니다.
3. **무료 한도 보호**: 무료 크레딧이나 최대 청구 한도에 도달해 `chargedCount === 0`이 되면 유료 연산 데이터를 유출하지 않고 `"Free tier or max charge limit reached"` 안내와 함께 안전하게 종료합니다.

---

## 5. 개인정보 보호 및 비자문(Non-Advisory) 안내

- **개인정보 0건 (`Zero-PII`)**: 이메일, 이름, 지갑 주소, 거래소 API 키를 일절 요구하거나 저장하지 않습니다. 다중 테넌트 속도 제한에 쓰이는 `X-Apify-User-ID` 역시 메모리 내에서 단방향 `SHA-256` 해시(12자리)로 마스킹 처리됩니다.
- **비자문 방화벽**: 모든 응답 최상단에 `"advisory": false`가 강제 포함되며 `BUY / SELL / HOLD / LONG / SHORT` 매매 추천 문구를 생성하지 않습니다. 모든 결과는 교육 및 리스크 시뮬레이션 목적의 결정론적 수학 계산치이며 투자 자문이 아닙니다.
