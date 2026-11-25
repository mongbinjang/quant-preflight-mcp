import { Actor } from 'apify';
import {
  createNonAdvisoryMeta,
  validateAndVerifyNonAdvisoryOutput,
} from '../types/schemas.js';

export type PpeEventName =
  | 'preflight-execution-risk'
  | 'scan-venue-microstructure'
  | 'audit-indicator-collinearity'
  | 'simulate-backtest-reality';

export interface ChargeCallResult {
  eventChargeLimitReached: boolean;
  chargedCount: number;
}

export type ChargeProvider = (opts: {
  eventName: PpeEventName;
  count: number;
}) => Promise<ChargeCallResult>;

export interface BillingGateOutcome<T extends Record<string, unknown>> {
  status: 'CHARGED' | 'CHARGED_AT_LIMIT' | 'SUPPRESSED_UNCHARGED';
  chargedCount: number;
  payload: T | Record<string, unknown>;
}

/**
 * Default production Apify PPE charger with LOCAL_STANDALONE=true stub support
 * for MCPize and local integration smoke tests.
 */
export function createDefaultChargeProvider(): ChargeProvider {
  return async ({ eventName, count }) => {
    if (process.env.LOCAL_STANDALONE === 'true') {
      return { eventChargeLimitReached: false, chargedCount: count };
    }
    const res = await Actor.charge({ eventName, count });
    return {
      eventChargeLimitReached: Boolean(res?.eventChargeLimitReached),
      chargedCount: typeof res?.chargedCount === 'number' ? res.chargedCount : count,
    };
  };
}

/**
 * Fail-Closed Billing Gate:
 * 1. Verifies output schema, finite numbers, and Non-Advisory Regulatory Firewall FIRST.
 * 2. Executes `Actor.charge()` at most once per tool invocation, right before returning.
 * 3. Enforces Phase 0 Refinement #1:
 *    - `eventChargeLimitReached === true && chargedCount >= 1`: returns paid data + `billing_notice`.
 *    - `eventChargeLimitReached === true && chargedCount === 0`: suppresses all paid data and
 *      returns only `"Free tier or max charge limit reached"` notice without crashing.
 */
export class BillingGate {
  private readonly chargeProvider: ChargeProvider;
  private totalChargedEvents = 0;
  private totalChargeCalls = 0;

  constructor(chargeProvider: ChargeProvider = createDefaultChargeProvider()) {
    this.chargeProvider = chargeProvider;
  }

  public getStats(): { totalChargeCalls: number; totalChargedEvents: number } {
    return {
      totalChargeCalls: this.totalChargeCalls,
      totalChargedEvents: this.totalChargedEvents,
    };
  }

  public async verifyAndCharge<T extends Record<string, unknown>>(
    eventName: PpeEventName,
    rawPayload: T
  ): Promise<BillingGateOutcome<T>> {
    // Step 1: Strict Non-Advisory & Finite-Number Output Firewall BEFORE charging
    const verified = validateAndVerifyNonAdvisoryOutput(rawPayload);

    // Step 2: Single choke-point charge call
    let invoked = false;
    if (invoked) {
      throw new Error('Duplicate charge guard triggered.');
    }
    invoked = true;
    this.totalChargeCalls += 1;

    const chargeRes = await this.chargeProvider({ eventName, count: 1 });
    const chargedCount = Math.max(0, Math.trunc(chargeRes.chargedCount ?? 0));
    this.totalChargedEvents += chargedCount;

    if (chargeRes.eventChargeLimitReached) {
      if (chargedCount >= 1) {
        const payloadWithNotice = validateAndVerifyNonAdvisoryOutput({
          meta: verified.meta,
          ...verified,
          billing_notice: 'Free tier or max charge limit reached',
        });
        return {
          status: 'CHARGED_AT_LIMIT',
          chargedCount,
          payload: payloadWithNotice,
        };
      }

      // chargedCount === 0: Budget already exhausted. Suppress paid output completely!
      const suppressedPayload = validateAndVerifyNonAdvisoryOutput({
        meta: createNonAdvisoryMeta(),
        billing_status: 'CHARGE_LIMIT_REACHED',
        charged: false,
        message: 'Free tier or max charge limit reached',
      });
      return {
        status: 'SUPPRESSED_UNCHARGED',
        chargedCount: 0,
        payload: suppressedPayload,
      };
    }

    return {
      status: 'CHARGED',
      chargedCount,
      payload: verified,
    };
  }
}
