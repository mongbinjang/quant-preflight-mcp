import { createHash } from 'node:crypto';

/**
 * Zero-PII Tenant Identifier Masker (PIPA & GDPR Compliant).
 * Hashes `X-Apify-User-ID` (or fallback IP) in volatile RAM using SHA-256 and truncates
 * to a non-reversible 12-hex-char digest. Raw user IDs are never logged or persisted.
 */
export function hashTenantIdentifier(rawId: string | undefined): string {
  const safeRaw = (rawId && rawId.trim().length > 0 ? rawId.trim() : 'anonymous-local').slice(
    0,
    256
  );
  return createHash('sha256')
    .update(`qml-trackb-salt:${safeRaw}`)
    .digest('hex')
    .slice(0, 12);
}

export interface RateLimitDecision {
  allowed: boolean;
  tenantHash: string;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Bounded In-Memory Sliding-Window Rate Limiter (default: 60 req / 60,000ms per tenant).
 */
export class TenantRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  private readonly maxTenants: number;
  private readonly nowFn: () => number;

  constructor(opts?: {
    maxRequestsPerWindow?: number;
    windowMs?: number;
    maxTenants?: number;
    nowFn?: () => number;
  }) {
    this.maxRequestsPerWindow = opts?.maxRequestsPerWindow ?? 60;
    this.windowMs = opts?.windowMs ?? 60_000;
    this.maxTenants = opts?.maxTenants ?? 5_000;
    this.nowFn = opts?.nowFn ?? (() => Date.now());
  }

  public check(rawTenantOrIp: string | undefined): RateLimitDecision {
    const tenantHash = hashTenantIdentifier(rawTenantOrIp);
    const now = this.nowFn();
    const cutoff = now - this.windowMs;

    let timestamps = this.buckets.get(tenantHash);
    if (timestamps) {
      timestamps = timestamps.filter((ts) => ts > cutoff);
    } else {
      if (this.buckets.size >= this.maxTenants) {
        this.pruneStaleBuckets(cutoff);
      }
      timestamps = [];
    }

    if (timestamps.length >= this.maxRequestsPerWindow) {
      this.buckets.set(tenantHash, timestamps);
      const oldestInWindow = timestamps[0] ?? now;
      const retryAfterMs = Math.max(100, oldestInWindow + this.windowMs - now);
      return {
        allowed: false,
        tenantHash,
        remaining: 0,
        retryAfterMs,
      };
    }

    timestamps.push(now);
    // Refresh LRU order
    this.buckets.delete(tenantHash);
    this.buckets.set(tenantHash, timestamps);

    return {
      allowed: true,
      tenantHash,
      remaining: Math.max(0, this.maxRequestsPerWindow - timestamps.length),
      retryAfterMs: 0,
    };
  }

  private pruneStaleBuckets(cutoff: number): void {
    for (const [key, list] of this.buckets.entries()) {
      const filtered = list.filter((ts) => ts > cutoff);
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, filtered);
      }
    }
    if (this.buckets.size >= this.maxTenants) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      }
    }
  }
}
