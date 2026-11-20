import { verify as verifyGithub } from '@octokit/webhooks-methods';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { normaliseEvents } from '../src/events.js';
import { github, paystack, stripe } from '../src/presets.js';

const ev = (body: string, headers: Record<string, string> = {}) =>
  normaliseEvents([{ id: 'x', body, headers }])[0]!;

describe('stripe preset', () => {
  const body = JSON.stringify({
    id: 'evt_123',
    object: 'event',
    type: 'payment_intent.succeeded',
    data: { object: {} },
  });
  const secret = 'whsec_test_123';

  it('produces signatures the official Stripe SDK accepts', () => {
    const headers = stripe.sign({
      body,
      secret,
      event: ev(body),
      attempt: 1,
      nowSec: Math.floor(Date.now() / 1000),
    });
    const client = new Stripe('sk_test_dummy');
    const event = client.webhooks.constructEvent(body, headers['stripe-signature']!, secret);
    expect(event.id).toBe('evt_123');
  });

  it('is rejected by the SDK with the wrong secret', () => {
    const headers = stripe.sign({
      body,
      secret,
      event: ev(body),
      attempt: 1,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(() =>
      new Stripe('sk_test_dummy').webhooks.constructEvent(body, headers['stripe-signature']!, 'whsec_other'),
    ).toThrow();
  });

  it('uses the event id as the natural key', () => expect(stripe.eventKey(ev(body))).toBe('evt_123'));
});

describe('paystack preset', () => {
  it('matches an HMAC-SHA512 vector computed independently with openssl', () => {
    const body = '{"event":"charge.success","data":{"reference":"ref_1"}}';
    const headers = paystack.sign({ body, secret: 'sk_test_vector', event: ev(body), attempt: 1, nowSec: 0 });
    expect(headers['x-paystack-signature']).toBe(
      '30b1a0fb0e4bf773dcff5a60700019cbff59e5e73c46d2d1a5b901c11baed13b6a993424a1dac299568f818f848b1488b395e7d2f98eef16945c7d833446d940',
    );
  });

  it('only treats 200 as success', () => {
    expect(paystack.isSuccess(200)).toBe(true);
    expect(paystack.isSuccess(201)).toBe(false);
    expect(paystack.isSuccess(204)).toBe(false);
  });

  it('keys events on the transaction reference', () => {
    expect(paystack.eventKey(ev('{"event":"charge.success","data":{"reference":"r1"}}'))).toBe('r1');
    expect(paystack.eventKey(ev('{"event":"refund.processed","data":{"transaction_reference":"r2"}}'))).toBe(
      'r2',
    );
  });
});

describe('github preset', () => {
  const body = '{"zen":"Keep it logically awesome."}';

  it('produces signatures @octokit/webhooks-methods accepts', async () => {
    const headers = github.sign({ body, secret: 'gh_secret', event: ev(body), attempt: 1, nowSec: 0 });
    expect(await verifyGithub('gh_secret', body, headers['x-hub-signature-256']!)).toBe(true);
    expect(headers['x-hub-signature-256']).toBe(
      'sha256=b593c682750fe5d8a1fb95f5441ad1d8879a1ed1b96b42bac9ccd75ceb49cf4e',
    );
  });

  it('keeps X-GitHub-Delivery stable across attempts and duplicates', () => {
    const e = ev(body, { 'x-github-event': 'ping' });
    const a = github.sign({ body, secret: 's', event: e, attempt: 1, nowSec: 0 });
    const b = github.sign({ body, secret: 's', event: e, attempt: 2, nowSec: 99 });
    expect(a['x-github-delivery']).toBe(b['x-github-delivery']);
    expect(a['x-github-event']).toBe('ping');
  });

  it('keeps a recorded delivery id', () => {
    const e = ev(body, { 'x-github-delivery': 'abc' });
    expect(github.sign({ body, secret: 's', event: e, attempt: 1, nowSec: 0 })['x-github-delivery']).toBe(
      'abc',
    );
  });

  it('does not retry', () => expect(github.maxAttempts).toBe(1));
});
