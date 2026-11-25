# 📖 QuantPreflight MCP (`quant-preflight-mcp`) 한국어 사용 및 운영 설명서

> **어려운 영어 설정이나 금융 서버 지식 없이도, 그대로 따라 치면 내 컴퓨터 테스트부터 Apify 유료 출시·AI 연결까지 끝나는 한글 매뉴얼입니다.**

---

## 1. 이 프로그램은 정확히 무엇인가요? (10초 이해)

- 예전 Track A(사람이 직접 숫자를 입력하는 웹사이트)와 달리, **`quant-preflight-mcp`는 사람 대신 AI(Claude, Cursor, ChatGPT, 자동매매 봇)가 호출해 쓰는 "무인 유료 계산 API 서버"**입니다.
- 내 컴퓨터나 Apify 클라우드에 올려두면, 전 세계 AI 사용자가 내 툴을 1번 호출할 때마다 **`$0.008` ~ `$0.025`(약 11원~35원)**가 자동으로 정산됩니다.
- **서버 유지비·프록시 원가 `$0`**, **오류 발생 시 자동 `$0` 청구(Fail-Closed)**로 설계되어 있어 고객 환불 분쟁이나 CS 부담이 거의 없습니다.

### AI에게 제공하는 4가지 유료 기능
1. **`preflight_execution_risk` (`$0.008`/회)**: 지금 당장 코인 선물을 시장가로 긁을 때 **실제 호가창 슬리피지, 왕복 수수료, 펀딩비, ATR 변동성 손절 폭, 하프켈리 안전 비중**을 0.3초 만에 계산합니다.
2. **`scan_venue_microstructure` (`$0.010`/회)**: 주요 선물 종목들의 **연환산 펀딩비, 미결제약정(OI), 호가 스프레드, $10k/$100k 충격 비용**을 한눈에 스캔합니다.
3. **`audit_indicator_collinearity` (`$0.025`/회)**: 트레이더가 쓰는 보조지표들(SMA, EMA, RSI, 볼린저밴드 등)이 서로 **중복(다중공선성·과적합)**인지 선형대수로 감사하고 독립 가중치를 뽑아줍니다.
4. **`simulate_backtest_reality` (`$0.025`/회)**: 백테스트 승률·손익비에 실제 수수료와 슬리피지를 넣었을 때 **5,000번 가상 시뮬레이션 결과(파산 확률 & 연속 손실 확률)**를 보여줍니다.

---

## 2. 내 컴퓨터에서 먼저 켜보고 확인하기 (테스트 방법)

PowerShell을 열고 아래 명령어를 순서대로 입력하면 내 PC에서 정상 작동하는지 바로 확인할 수 있습니다.

```powershell
cd "c:\Users\monke\OneDrive\Desktop\쉽게설명해주는사람\track-b-quant-preflight-mcp"

# 1. 타입 검사 & 45개 자동 검증 테스트 실행 (모두 통과해야 정상)
npm.cmd run typecheck
npm.cmd test

# 2. 내 PC에서 독립 서버로 켜기 (과금 없이 무료 테스트 모드)
$env:LOCAL_STANDALONE="true"
npm.cmd start
```

- 화면에 `"event":"quant_preflight_mcp_started"`가 뜨면 성공입니다.
- 새 PowerShell 창을 열어 `Invoke-RestMethod http://localhost:3000/health` 를 입력했을 때 `status: ok, mode: multi-tenant`가 나오면 완벽히 작동 중입니다. (종료하려면 원래 창에서 `Ctrl + C`를 누르세요.)

---

## 3. Apify에 올려서 실제로 돈 벌기 (배포 4단계)

### 1단계: Apify 로그인 및 코드 업로드
```powershell
cd "c:\Users\monke\OneDrive\Desktop\쉽게설명해주는사람\track-b-quant-preflight-mcp"
npx apify-cli login
npx apify-cli push
```
- 처음엔 **비공개(Private)** 상태로 업로드됩니다. 바로 공개하지 말고 아래 2~3단계를 먼저 점검하세요.

### 2단계: Apify 웹 콘솔에서 체크할 3가지 설정
Apify 웹사이트(`console.apify.com`) → 내가 올린 Actor(`quant-preflight-mcp`)로 들어가서 확인합니다.
1. **Server 모드 켜기 (`Settings` → `Server`, 구 Standby)**:
   - **Enable Server mode** 체크 확인 (`actor.json` 내부 키: `usesStandbyMode: true`)
   - **Memory**: `256 MB` 또는 `512 MB` 선택
   - **Idle timeout**: `120` ~ `180`초
   - *(상단 **`Server`** 탭을 누르면 AI가 접속할 서버 URL을 바로 복사할 수 있습니다.)*
2. **유료 과금(PPE) 설정 (`Monetization` → `Pay per event`)**:
   - `.actor/pay_per_event.json`의 4개 이벤트(`$0.008`, `$0.010`, `$0.025`, `$0.025`)가 등록되어 있는지 확인합니다.
   - **최소 최대 청구 한도 (`minimalMaxTotalChargeUsd`)** 를 **`0.05`** (`$0.05`)로 설정합니다. (이렇게 해야 무료 체험 유저도 4개 도구를 모두 막힘없이 눌러볼 수 있습니다.)

### 3단계: ⭐ 필수! 클라우드 서버에서 거래소 차단 여부 확인
내 집 인터넷에서는 거래소 API가 잘 열려도, Apify 클라우드 서버(미국/유럽 AWS IP)에서 차단되는지 **반드시 공개 전에 1번 테스트**해야 합니다.
아래 `<내_아이디>`와 `<내_APIFY_토큰>`만 바꿔서 실행하세요.

```powershell
# ① 서버 생존 확인 ({"status":"ok","mode":"multi-tenant"} 가 나와야 함)
curl.exe -i "https://<내_아이디>--quant-preflight-mcp.apify.actor/health" -H "Authorization: Bearer <내_APIFY_토큰>"

# ② 주 거래소(Hyperliquid) 정상 응답 확인
curl.exe -i -X POST "https://<내_아이디>--quant-preflight-mcp.apify.actor/mcp" `
  -H "Authorization: Bearer <내_APIFY_토큰>" `
  -H "Content-Type: application/json" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preflight_execution_risk","arguments":{"symbol":"BTCUSDT","order_size_usd":25000,"side":"buy","venue":"hyperliquid"}}}'

# ③ 예비 거래소(OKX) 정상 응답 확인
curl.exe -i -X POST "https://<내_아이디>--quant-preflight-mcp.apify.actor/mcp" `
  -H "Authorization: Bearer <내_APIFY_토큰>" `
  -H "Content-Type: application/json" `
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"preflight_execution_risk","arguments":{"symbol":"BTC-PERP","order_size_usd":25000,"side":"buy","venue":"okx"}}}'
```
- **둘 다 `HTTP 200`과 숫자가 잘 나오면 성공!** 만약 한쪽이 403/451 에러가 나면 Apify 콘솔에서 Standby 리전(미국 ↔ 유럽)을 바꾸면 됩니다.

### 4단계: Apify Store 공개(Publish) 및 MCPize 동시 입점
- 3단계 통과 후 Apify 콘솔에서 **Publish to Store**를 누르면 판매가 시작됩니다. (`README.md`가 이미 전환율 최적화 영문으로 작성되어 있어 품질 점수 확보에 유리합니다.)
- **MCPize에도 추가 입점할 때**: 루트의 `Dockerfile`을 그대로 올리되, 환경변수에 **`LOCAL_STANDALONE=true`**, **`PORT=3000`** 2개만 넣어주면 Apify 과금 코드 대신 MCPize 자체 과금 게이트웨이와 연동되어 이중 수익원이 됩니다.

---

## 4. Claude / Cursor에 연결해서 직접 써보기

고객(또는 운영자님 본인)이 Claude Desktop이나 Cursor에서 내 서버를 쓰고 싶을 때, 설정 파일(`claude_desktop_config.json` 또는 `.cursor/mcp.json`)에 아래 8줄만 붙여넣으면 됩니다.

```json
{
  "mcpServers": {
    "quant-preflight": {
      "url": "https://<내_아이디>--quant-preflight-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer <내_APIFY_토큰>"
      }
    }
  }
}
```

연결 후 AI 채팅창에 이렇게 한국어로 물어보면 AI가 알아서 내 툴을 호출해 답해줍니다:
- *"비트코인(BTC) 25,000달러어치 시장가 매수할 때 호가창 슬리피지랑 1시간봉 ATR 기준 손절 폭 계산해줘."*
- *"지금 무기한 선물 중에서 미결제약정이 크고 펀딩비 연환산이 높은 종목 5개만 스캔해줘."*
- *"BTC 1시간봉 기준으로 `sma_5`, `sma_20`, `ema_12`, `rsi_14`, `bb_upper`, `atr_14` 지표가 서로 중복되는지 검사해줘."*
- *"승률 52%, 평균 익절 0.8%, 평균 손절 0.5%, 1회 리스크 1.5% 전략으로 250번 매매할 때 슬리피지 반영한 5,000번 파산 확률 돌려줘."*

---

## 5. 자주 묻는 질문 & 운영 안전장치 (FAQ)

- **Q1. 거래소 API가 갑자기 먹통이 되면 고객에게 돈이 잘못 청구되나요?**
  - **아니요, 절대 0원입니다.** `Actor.charge()`는 거래소 조회와 수학 계산, 출력 검증이 100% 성공한 맨 마지막 순간에만 실행됩니다. 에러가 나면 과금 함수 자체가 호출되지 않습니다.
- **Q2. 무료 체험 고객이 예산을 다 써버리면(`$0` 결제 상태) 유료 결과가 공짜로 새어나가나요?**
  - **아니요.** 과금 한도 도달로 `chargedCount === 0`이 반환되면 서버가 유료 분석 데이터를 즉시 숨기고 `"Free tier or max charge limit reached"` 안내만 출력한 뒤 에러 없이 종료합니다.
- **Q3. 고객 정보나 거래소 API 키가 서버에 저장되나요?**
  - **아니요.** 거래소 API 키를 아예 받지 않으며, 테넌트 식별자(`X-Apify-User-ID`)도 메모리에서 즉시 복구 불가능한 12자리 해시로 변환해 분당 60회 속도 제한 용도로만 쓰고 저장하지 않습니다.
- **Q4. 수익금 인출은 어떻게 하나요? (한국 거주자 기준)**
  - Apify 수익금은 Wise USD 계좌 수취가 제한되므로 **PayPal**로 수취하되, 환전·인출 수수료 손실을 막기 위해 **잔액 `$120` 이상 모였을 때 한 번에 인출**하는 것을 권장합니다.
- **Q5. 언제 접거나 다음 프로젝트를 해야 하나요? (30/60/90일 기준)**
  - **30일차**: 스토어 품질 점수 80점 이상 · 크래시 0건 · 외부 체험 유저 15명 이상 확인 → 디렉터리(`mcp.so`, Smithery 등) 등록
  - **60일차**: 반복 결제 고객 5명 이상 또는 월 `$25+` 미달 시 추가 기능 개발을 멈추고(유지비 `$0` 방치) 다음 B2B Actor 2호기로 이동합니다.
