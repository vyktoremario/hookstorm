import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProviderName } from './presets.js';

const SAMPLE_EVENTS: Record<Exclude<ProviderName, 'custom'>, object[]> = {
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
};

const SECRET_ENV: Record<ProviderName, string> = {
  stripe: 'STRIPE_WEBHOOK_SECRET',
  paystack: 'PAYSTACK_SECRET_KEY',
  github: 'GITHUB_WEBHOOK_SECRET',
  custom: 'WEBHOOK_SECRET',
};

function configTemplate(provider: Exclude<ProviderName, 'custom'>, target: string): string {
  const key =
    provider === 'stripe'
      ? '(call) => call.body.paymentIntentId'
      : provider === 'paystack'
        ? '(call) => call.body.reference'
        : '(call) => call.body.deliveryId';
  return `import { defineConfig, atMostOnce } from 'hookstorm-cli';

export default defineConfig({
  target: '${target}',
  provider: '${provider}',
  // The TEST-mode secret your local app verifies signatures with. Never a production secret.
  secret: process.env.${SECRET_ENV[provider]} ?? 'whsec_test_local',
  events: './hookstorm.events.jsonl',
  profile: 'realistic',

  // Point your app's side effects (charges, emails, shipments) at the sink:
  //   POST http://127.0.0.1:4400/sink/<effect-name>  with a JSON body
  sink: { port: 4400 },

  // Optional test-only endpoints in your app:
  // reset: 'http://localhost:3000/hookstorm/reset',   // POST, clears state between seeds
  // probe: 'http://localhost:3000/hookstorm/state',   // GET, JSON snapshot for finalState()

  invariants: [
    atMostOnce('fulfil', ${key}, 'each payment is fulfilled at most once'),
  ],
});
`;
}

export async function runInit(
  provider: ProviderName,
  target: string,
  dir = process.cwd(),
): Promise<string[]> {
  if (provider === 'custom')
    throw new Error('init supports stripe, paystack and github; copy one and edit it for custom');
  const configPath = resolve(dir, 'hookstorm.config.ts');
  const eventsPath = resolve(dir, 'hookstorm.events.jsonl');
  for (const p of [configPath, eventsPath]) if (existsSync(p)) throw new Error(`${p} already exists`);
  await writeFile(configPath, configTemplate(provider, target));
  await writeFile(eventsPath, SAMPLE_EVENTS[provider].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return [configPath, eventsPath];
}
