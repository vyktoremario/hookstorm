import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigError } from './config.js';
import type { ProviderName } from './presets.js';

const SAMPLE_EVENTS: Record<ProviderName, object[]> = {
  stripe: [
    {
      id: 'evt_pi_1',
      body: {
        id: 'evt_1',
        object: 'event',
        type: 'payment_intent.succeeded',
        livemode: false,
        data: {
          object: {
            id: 'pi_1',
            object: 'payment_intent',
            amount: 5000,
            currency: 'usd',
            metadata: { order_id: 'ord_1' },
          },
        },
      },
    },
    {
      id: 'evt_refund_1',
      body: {
        id: 'evt_2',
        object: 'event',
        type: 'charge.refunded',
        livemode: false,
        data: {
          object: {
            id: 'ch_1',
            object: 'charge',
            payment_intent: 'pi_1',
            amount_refunded: 5000,
            metadata: { order_id: 'ord_1' },
          },
        },
      },
    },
  ],
  paystack: [
    {
      id: 'evt_charge_1',
      body: {
        event: 'charge.success',
        data: {
          id: 1001,
          reference: 'ref_1001',
          amount: 500000,
          currency: 'NGN',
          status: 'success',
          customer: { email: 'ada@example.com' },
        },
      },
    },
    {
      id: 'evt_refund_1',
      body: {
        event: 'refund.processed',
        data: { transaction_reference: 'ref_1001', amount: 500000, status: 'processed' },
      },
    },
  ],
  github: [
    {
      id: 'evt_push_1',
      headers: { 'x-github-event': 'push' },
      body: { ref: 'refs/heads/main', after: 'abc123', repository: { full_name: 'acme/app' } },
    },
  ],
  custom: [
    {
      id: 'evt_paid_1',
      type: 'payment.completed',
      body: { event: 'payment.completed', data: { reference: 'ref_1', amount: 5000, currency: 'NGN' } },
    },
    {
      id: 'evt_paid_2',
      type: 'payment.completed',
      body: { event: 'payment.completed', data: { reference: 'ref_2', amount: 1200, currency: 'NGN' } },
    },
  ],
};

const SECRET_ENV: Record<ProviderName, string> = {
  stripe: 'STRIPE_WEBHOOK_SECRET',
  paystack: 'PAYSTACK_SECRET_KEY',
  github: 'GITHUB_WEBHOOK_SECRET',
  custom: 'WEBHOOK_SECRET',
};

const SINK_KEY: Record<ProviderName, string> = {
  stripe: '(call) => call.body.paymentIntentId',
  paystack: '(call) => call.body.reference',
  github: '(call) => call.body.deliveryId',
  custom: '(call) => call.body.reference',
};

const CUSTOM_PROVIDER = `  // Any provider without a preset. Reproduce the signature your receiver checks, e.g.:
  //   HMAC-SHA256 hex of the raw body:  ({ body, secret }) => ({ 'x-signature': createHmac('sha256', secret).update(body).digest('hex') })
  //   HMAC-SHA512 (Monnify-style):      ({ body, secret }) => ({ 'monnify-signature': createHmac('sha512', secret).update(body).digest('hex') })
  //   Shared secret header (Flutterwave-style "secret hash"): ({ secret }) => ({ 'verif-hash': secret })
  //   No verification in test mode:     () => ({})
  provider: 'custom',
  sign: ({ body, secret }) => ({ 'x-signature': createHmac('sha256', secret).update(body).digest('hex') }),
  // Match the provider's delivery rules: how many attempts, and gaps between them (compressed, in ms).
  maxAttempts: 5,
  backoffMs: [50, 100, 200, 400],`;

function configTemplate(provider: ProviderName, target: string): string {
  const imports =
    provider === 'custom'
      ? `import { createHmac } from 'node:crypto';\nimport { atMostOnce, custom, defineConfig } from 'hookstorm-cli';`
      : `import { atMostOnce, custom, defineConfig } from 'hookstorm-cli';`;
  const providerBlock = provider === 'custom' ? CUSTOM_PROVIDER : `  provider: '${provider}',`;
  return `${imports}

// Guide: https://github.com/vyktoremario/hookstorm/blob/main/docs/guide-your-own-receiver.md
export default defineConfig({
  target: '${target}',
${providerBlock}
  // The TEST-mode secret your local app verifies signatures with. Never a production secret.
  secret: process.env.${SECRET_ENV[provider]} ?? 'test_secret_local',
  events: './hookstorm.events.jsonl',
  profile: 'realistic',

  // Two ways to see what your app did (use one or both):
  //
  // 1. Sink: point the app's outgoing calls (payment API, email, fulfilment) at
  //    http://127.0.0.1:4400/sink/<effect-name> in test mode. Each call is recorded.
  sink: { port: 4400 },
  //
  // 2. Probe: add test-only routes to your app and read its state after each run.
  //    Paths resolve against the target's origin.
  // reset: '/hookstorm/reset', // POST: clear state between seeds
  // probe: '/hookstorm/state', // GET: JSON snapshot, available to finalState() and custom()

  invariants: [
    // With the sink:
    atMostOnce('fulfil', ${SINK_KEY[provider]}, 'each payment is fulfilled at most once'),

    // With the probe only (no sink needed), e.g. if /hookstorm/state returns { ledger: [{ reference }] }:
    custom('one ledger entry per payment', ({ state }) => {
      if (!state) return; // enable \`probe\` above to use this
      const seen = new Map<string, number>();
      for (const row of state.ledger ?? []) seen.set(row.reference, (seen.get(row.reference) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([ref, n]) => \`\${ref} has \${n} ledger entries\`);
    }),
  ],
});
`;
}

export async function runInit(
  provider: ProviderName,
  target: string,
  dir = process.cwd(),
): Promise<string[]> {
  if (!(provider in SAMPLE_EVENTS)) throw new ConfigError(`Unknown provider "${provider}"`);
  const configPath = resolve(dir, 'hookstorm.config.ts');
  const eventsPath = resolve(dir, 'hookstorm.events.jsonl');
  for (const p of [configPath, eventsPath]) if (existsSync(p)) throw new ConfigError(`${p} already exists`);
  await writeFile(configPath, configTemplate(provider, target));
  await writeFile(eventsPath, SAMPLE_EVENTS[provider].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return [configPath, eventsPath];
}
