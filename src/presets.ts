import { createHash, createHmac } from 'node:crypto';
import type { Signer, WebhookEvent } from './types.js';

export type ProviderName = 'stripe' | 'paystack' | 'github' | 'custom';

/**
 * Provider delivery semantics, compressed in time. Only attempt count, ordering and what counts as success
 * matter for receiver correctness; real backoff schedules (minutes to days) are collapsed to milliseconds.
 */
export interface ProviderPreset {
  name: ProviderName;
  /** Simulated attempts per delivery (capped: more attempts rarely find new bugs). */
  maxAttempts: number;
  /** Compressed wait before attempt k+1 (last value repeats). */
  backoffMs: number[];
  /** Does this response status stop retries? */
  isSuccess(status: number): boolean;
  /** Recorded headers that must not be replayed (they are re-signed). Lower-case. */
  stripHeaders: string[];
  sign: Signer;
  /** Best guess at the provider's natural idempotency key, used for reporting. */
  eventKey(event: WebhookEvent): string | undefined;
  /** Facts the preset is based on, with sources. */
  notes: string[];
}

const hmacHex = (algo: 'sha256' | 'sha512', secret: string, data: string) =>
  createHmac(algo, secret).update(data, 'utf8').digest('hex');

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export const stripe: ProviderPreset = {
  name: 'stripe',
  maxAttempts: 5,
  backoffMs: [50, 100, 200, 400],
  isSuccess: (s) => s >= 200 && s < 300,
  stripHeaders: ['stripe-signature'],
  // Stripe-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>.<raw body>")). Each attempt gets a fresh
  // timestamp, as Stripe's own retries do, so delayed events stay inside the 5-minute tolerance.
  sign: ({ body, secret, nowSec }) => ({
    'stripe-signature': `t=${nowSec},v1=${hmacHex('sha256', secret, `${nowSec}.${body}`)}`,
  }),
  eventKey: (e) => {
    const id = obj(e.json).id;
    return typeof id === 'string' ? id : undefined;
  },
  notes: [
    'Live mode retries for up to three days with exponential backoff; sandbox retries three times over a few hours. https://docs.stripe.com/webhooks',
    'Any 2xx counts as success. Slow handlers time out; Stripe recommends returning 2xx before complex logic. https://docs.stripe.com/webhooks',
  ],
};

export const paystack: ProviderPreset = {
  name: 'paystack',
  maxAttempts: 5,
  backoffMs: [60, 60, 60, 120],
  // Paystack's webhook guide only treats 200 OK as acknowledged.
  isSuccess: (s) => s === 200,
  stripHeaders: ['x-paystack-signature'],
  // x-paystack-signature: hex(HMAC-SHA512(secret key, raw body))
  sign: ({ body, secret }) => ({ 'x-paystack-signature': hmacHex('sha512', secret, body) }),
  eventKey: (e) => {
    const data = obj(obj(e.json).data);
    const ref = data.reference ?? data.transaction_reference ?? data.id;
    return ref === undefined ? undefined : String(ref);
  },
  notes: [
    'Live mode: retried every 3 minutes for the first 4 tries, then hourly for 72 hours. https://paystack.com/docs/payments/webhooks/',
    'Only a 200 OK is treated as success; attempts time out after 30 seconds. https://paystack.com/docs/payments/webhooks/',
    'Events carry no event id: deduplicate on data.reference / data.id.',
  ],
};

export const github: ProviderPreset = {
  name: 'github',
  maxAttempts: 1,
  backoffMs: [],
  isSuccess: (s) => s >= 200 && s < 300,
  stripHeaders: ['x-hub-signature-256', 'x-hub-signature'],
  // X-Hub-Signature-256: sha256=hex(HMAC-SHA256(secret, raw body)). X-GitHub-Delivery stays the same across
  // duplicates of one event, as it does on GitHub redeliveries.
  sign: ({ body, secret, event }) => ({
    'x-hub-signature-256': `sha256=${hmacHex('sha256', secret, body)}`,
    'x-github-event': event.headers['x-github-event'] ?? event.type,
    'x-github-delivery': event.headers['x-github-delivery'] ?? deterministicGuid(event.id),
  }),
  eventKey: (e) => e.headers['x-github-delivery'] ?? deterministicGuid(e.id),
  notes: [
    'GitHub does not automatically redeliver failed deliveries; a response slower than 10 s is recorded as a failure. https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries',
  ],
};

export function customPreset(sign: Signer | undefined): ProviderPreset {
  return {
    name: 'custom',
    maxAttempts: 5,
    backoffMs: [50, 100, 200, 400],
    isSuccess: (s) => s >= 200 && s < 300,
    stripHeaders: [],
    sign: sign ?? (() => ({})),
    eventKey: () => undefined,
    notes: ['Custom provider: signing and retry policy come from your config.'],
  };
}

export function getPreset(name: ProviderName, sign?: Signer): ProviderPreset {
  switch (name) {
    case 'stripe':
      return stripe;
    case 'paystack':
      return paystack;
    case 'github':
      return github;
    case 'custom':
      return customPreset(sign);
    default:
      throw new Error(`Unknown provider "${String(name)}". Use stripe, paystack, github or custom.`);
  }
}

/** Stable UUID-shaped id derived from the fixture id. */
export function deterministicGuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
