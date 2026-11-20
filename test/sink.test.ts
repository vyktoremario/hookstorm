import { afterEach, describe, expect, it } from 'vitest';
import { SinkServer } from '../src/sink.js';

let sink: SinkServer | undefined;
afterEach(async () => {
  await sink?.stop();
  sink = undefined;
});

const send = (url: string, effect: string, body: unknown) =>
  fetch(`${url}/${effect}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('SinkServer', () => {
  it('records calls with parsed bodies', async () => {
    sink = new SinkServer();
    await sink.start(0);
    sink.reset(1);
    const res = await send(sink.url, 'wallet.credit', { ref: 'a' });
    expect(res.status).toBe(200);
    await send(sink.url, 'email/receipt', { ref: 'a' });
    expect(sink.calls.map((c) => [c.effect, c.body, c.ok])).toEqual([
      ['wallet.credit', { ref: 'a' }, true],
      ['email.receipt', { ref: 'a' }, true],
    ]);
  });

  it('injects failures deterministically per seed and logical call', async () => {
    const statuses = async (seed: number) => {
      const s = new SinkServer({ charge: 0.5 });
      await s.start(0);
      s.reset(seed);
      const out: number[] = [];
      for (let i = 0; i < 20; i++) out.push((await send(s.url, 'charge', { ref: `r${i}` })).status);
      await s.stop();
      return out;
    };
    const a = await statuses(7);
    expect(await statuses(7)).toEqual(a);
    expect(a).toContain(503);
    expect(a).toContain(200);
  });

  it('never fails the same call more than maxConsecutive times in a row', async () => {
    sink = new SinkServer({ charge: { failRate: 1, maxConsecutive: 2, status: 502 } });
    await sink.start(0);
    sink.reset(1);
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push((await send(sink.url, 'charge', { ref: 'same' })).status);
    expect(out).toEqual([502, 502, 200, 502, 502, 200]);
    expect(sink.calls.filter((c) => c.ok)).toHaveLength(2);
  });

  it('reset clears calls', async () => {
    sink = new SinkServer();
    await sink.start(0);
    await send(sink.url, 'x', {});
    sink.reset(2);
    expect(sink.calls).toEqual([]);
  });
});
