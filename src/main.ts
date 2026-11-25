import { Actor, Dataset } from 'apify';
import { VenueRouter } from './adapters/venueRouter.js';
import { BillingGate } from './billing/billingGate.js';
import { FROZEN_TOOL_NAMES, type FrozenToolName, executeToolByName } from './mcp/tools.js';
import { createQuantPreflightApp } from './server.js';

interface BatchConsoleInput {
  tool?: FrozenToolName;
  params?: Record<string, unknown>;
}

function isStandbyOrServerMode(): boolean {
  if (process.env.LOCAL_STANDALONE === 'true') return true;
  if (process.env.APIFY_META_ORIGIN === 'STANDBY') return true;
  if (process.env.ACTOR_STANDBY_PORT || process.env.ACTOR_WEB_SERVER_PORT) return true;
  return false;
}

async function main(): Promise<void> {
  const standalone = process.env.LOCAL_STANDALONE === 'true';
  if (!standalone) {
    await Actor.init();
  }

  const router = new VenueRouter();
  const billing = new BillingGate();

  // Mode B Fallback: Apify Console One-Shot Input Execution (when not running in Standby HTTP mode)
  if (!isStandbyOrServerMode() && !standalone) {
    const input = (await Actor.getInput<BatchConsoleInput>()) ?? {};
    const selectedTool = input.tool ?? 'scan_venue_microstructure';
    const toolParams = input.params ?? {};

    if (!FROZEN_TOOL_NAMES.includes(selectedTool)) {
      await Actor.fail(
        `Invalid tool "${String(selectedTool)}". Supported tools: ${FROZEN_TOOL_NAMES.join(', ')}`
      );
      return;
    }

    const result = await executeToolByName(selectedTool, toolParams, { router, billing });
    const textPayload = result.content[0]?.text ?? '{}';
    const parsed = JSON.parse(textPayload) as Record<string, unknown>;

    await Dataset.pushData({
      tool: selectedTool,
      isError: Boolean(result.isError),
      result: parsed,
    });

    await Actor.exit();
    return;
  }

  // Primary Mode A: Apify Multi-Tenant Standby Server & MCPize Streamable HTTP Server
  const port = Number(
    process.env.ACTOR_STANDBY_PORT ||
      process.env.ACTOR_WEB_SERVER_PORT ||
      process.env.PORT ||
      3000
  );
  const host = '0.0.0.0';
  const { app } = createQuantPreflightApp({ router, billing });

  const server = app.listen(port, host, () => {
    console.log(
      JSON.stringify({
        event: 'quant_preflight_mcp_started',
        host,
        port,
        mode: standalone ? 'local_standalone' : 'apify_standby_multi_tenant',
        mcpEndpoint: '/mcp',
        healthEndpoint: '/health',
      })
    );
  });

  const shutdown = async () => {
    server.close();
    if (!standalone) {
      await Actor.exit().catch(() => undefined);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: 'fatal_startup_error',
      message: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
