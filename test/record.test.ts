import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEventsFile } from '../src/events.js';
import { startRecorder } from '../src/record.js';
import { fakeReceiver } from './helpers.js';

describe('hookstorm record', () => {
  it('saves raw bodies without signatures, forwards unchanged, and skips live-mode events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-rec-'));
    const out = join(dir, 'events.jsonl');
    const app = await fakeReceiver(() => ({ status: 202 }));
    const rec = await startRecorder({ provider: 'stripe', port: 0, forward: app.url, out });
    try {
      const raw = '{"id":"evt_1","type":"payment_intent.succeeded",  "livemode":false}';
      const res = await fetch(rec.url, {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=abc', 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status).toBe(202);
      await fetch(rec.url, { method: 'POST', body: '{"id":"evt_2","type":"x","livemode":true}' });

      const lines = (await readFile(out, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const saved = JSON.parse(lines[0]!);
      expect(saved.body).toBe(raw); // byte-for-byte, odd whitespace included
      expect(saved.type).toBe('payment_intent.succeeded');
      expect(saved.headers['stripe-signature']).toBeUndefined();
      expect(app.requests[0]!.headers['stripe-signature']).toBe('t=1,v1=abc'); // forwarded untouched
      expect((await loadEventsFile(out))[0]!.body).toBe(raw); // fixture round-trips
    } finally {
      await rec.close();
      await app.close();
    }
  });
});
