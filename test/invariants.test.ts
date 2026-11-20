import { describe, expect, it } from 'vitest';
import {
  atMostOnce,
  custom,
  eventsTakeEffect,
  exactlyOnce,
  finalState,
  monotonic,
} from '../src/invariants.js';
import { call, events, observations } from './helpers.js';

const byRef = (c: { body: unknown }) => (c.body as { ref: string }).ref;

describe('atMostOnce', () => {
  const inv = atMostOnce('charge', byRef, 'charge once');
  it('passes when each key happens once', async () => {
    expect(
      await inv.check(
        observations({ sink: [call(1, 'charge', { ref: 'a' }), call(2, 'charge', { ref: 'b' })] }),
      ),
    ).toEqual([]);
  });
  it('flags duplicates with evidence', async () => {
    const v = await inv.check(
      observations({
        sink: [
          call(1, 'charge', { ref: 'a' }),
          call(2, 'charge', { ref: 'a' }),
          call(3, 'other', { ref: 'a' }),
        ],
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ invariant: 'charge once', key: 'a', message: 'charge happened 2× for a' });
    expect(v[0]!.sinkCalls!.map((c) => c.seq)).toEqual([1, 2]);
  });
  it('ignores calls the sink failed', async () => {
    expect(
      await inv.check(
        observations({ sink: [call(1, 'charge', { ref: 'a' }, false), call(2, 'charge', { ref: 'a' })] }),
      ),
    ).toEqual([]);
  });
});

describe('exactlyOnce', () => {
  const evs = events({ type: 'paid', ref: 'a' }, { type: 'paid', ref: 'b' }, { type: 'other', ref: 'c' });
  const inv = exactlyOnce('ship', byRef, {
    forEachEvent: 'paid',
    eventKey: (e) => (e.json as { ref: string }).ref,
  });

  it('passes when every acknowledged event has exactly one effect', async () => {
    const obs = observations({
      events: evs,
      sink: [call(1, 'ship', { ref: 'a' }), call(2, 'ship', { ref: 'b' })],
    });
    expect(await inv.check(obs)).toEqual([]);
  });
  it('flags a lost event', async () => {
    const v = await inv.check(observations({ events: evs, sink: [call(1, 'ship', { ref: 'a' })] }));
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe('b');
    expect(v[0]!.message).toMatch(/event lost/);
  });
  it('flags duplicates', async () => {
    const v = await inv.check(
      observations({
        events: evs,
        sink: [call(1, 'ship', { ref: 'a' }), call(2, 'ship', { ref: 'a' }), call(3, 'ship', { ref: 'b' })],
      }),
    );
    expect(v.map((x) => x.key)).toEqual(['a']);
  });
  it('skips events the provider never got a success for', async () => {
    const obs = observations({ events: evs, acked: ['e1'], sink: [call(1, 'ship', { ref: 'a' })] });
    expect(await inv.check(obs)).toEqual([]);
  });
  it('accepts a predicate for forEachEvent', async () => {
    const pred = exactlyOnce('ship', byRef, {
      forEachEvent: (e) => e.id === 'e3',
      eventKey: (e) => (e.json as { ref: string }).ref,
    });
    expect((await pred.check(observations({ events: evs, sink: [] })))[0]!.key).toBe('c');
  });
});

describe('monotonic', () => {
  const inv = monotonic('order.status', ['pending', 'paid', 'refunded'], {
    key: (c) => (c.body as { id: string }).id,
  });
  it('passes forward-only transitions and repeats', async () => {
    const sink = ['pending', 'paid', 'paid', 'refunded'].map((status, i) =>
      call(i, 'order.status', { id: 'o1', status }),
    );
    expect(await inv.check(observations({ sink }))).toEqual([]);
  });
  it('flags a backwards transition', async () => {
    const sink = ['paid', 'refunded', 'paid'].map((status, i) =>
      call(i, 'order.status', { id: 'o1', status }),
    );
    const v = await inv.check(observations({ sink }));
    expect(v[0]!.message).toBe('o1 went backwards: refunded → paid');
  });
});

describe('finalState', () => {
  it('reports a missing probe', async () => {
    const v = await finalState('x', () => true).check(observations({}));
    expect(v[0]!.message).toMatch(/configure `probe`/);
  });
  it.each([
    [true, 0],
    [undefined, 0],
    [[], 0],
    [false, 1],
    ['bad', 1],
    [['a', 'b'], 2],
  ])('maps result %j to %i violations', async (result, n) => {
    expect(await finalState('x', () => result as never).check(observations({ state: {} }))).toHaveLength(n);
  });
  it('passes state and observations to the predicate', async () => {
    const inv = finalState('balance', (state: { b: number }, obs) => state.b === obs.seed);
    expect(await inv.check(observations({ state: { b: 1 } }))).toEqual([]);
  });
});

describe('custom', () => {
  it('accepts strings and objects', async () => {
    const inv = custom('mine', () => ['one', { message: 'two', key: 'k' }]);
    expect(await inv.check(observations({}))).toEqual([
      { invariant: 'mine', message: 'one' },
      { invariant: 'mine', message: 'two', key: 'k' },
    ]);
  });
  it('treats no return value as a pass', async () => {
    expect(await custom('ok', () => undefined).check(observations({}))).toEqual([]);
  });
});

describe('eventsTakeEffect', () => {
  const evs = events(
    { type: 'paid', order: 'o1' },
    { type: 'paid', order: 'o2' },
    { type: 'paid', order: 'o3' },
    { type: 'noise', order: 'o1' },
  );
  const byProbe = eventsTakeEffect({
    forEachEvent: 'paid',
    eventKey: (e) => (e.json as { order: string }).order,
    record: (state, id) => state.orders.find((o: { id: string }) => o.id === id),
  });
  const baseline = {
    orders: [
      { id: 'o1', status: 'pending' },
      { id: 'o2', status: 'pending' },
    ],
  };

  it('passes when every acknowledged event changed its record', async () => {
    const state = {
      orders: [
        { id: 'o1', status: 'paid' },
        { id: 'o2', status: 'paid' },
      ],
    };
    const obs = observations({ events: evs.slice(0, 2), baseline, state });
    expect(await byProbe.check(obs)).toEqual([]);
  });

  it('flags an event whose record was never seeded, and one that changed nothing', async () => {
    const state = {
      orders: [
        { id: 'o1', status: 'paid' },
        { id: 'o2', status: 'pending' },
      ],
    };
    const v = await byProbe.check(observations({ events: evs, baseline, state }));
    expect(v.map((x) => [x.key, x.message])).toEqual([
      ['o2', 'paid for o2 was acknowledged but changed nothing'],
      [
        'o3',
        "paid for o3 was acknowledged, but o3 doesn't exist: seed it in reset, or the event can't be tested",
      ],
    ]);
  });

  it('ignores events the provider never got a success for', async () => {
    const obs = observations({
      events: evs,
      acked: ['e1'],
      baseline,
      state: { orders: [{ id: 'o1', status: 'paid' }] },
    });
    expect(await byProbe.check(obs)).toEqual([]);
  });

  it('needs probe snapshots in probe mode', async () => {
    expect((await byProbe.check(observations({ events: evs })))[0]!.message).toMatch(/configure `probe`/);
  });

  it('accepts several event types', async () => {
    const both = eventsTakeEffect({
      forEachEvent: ['paid', 'noise'],
      eventKey: (e) => (e.json as { order: string }).order,
      record: (state, id) => state.orders.find((o: { id: string }) => o.id === id),
    });
    const state = {
      orders: [
        { id: 'o1', status: 'paid' },
        { id: 'o2', status: 'paid' },
      ],
    };
    const v = await both.check(observations({ events: [evs[0]!, evs[3]!], baseline, state }));
    expect(v).toEqual([]);
    expect(both.name).toBe('every acknowledged paid / noise event takes effect');
  });

  it('sink mode: requires the effect for each acknowledged event', async () => {
    const bySink = eventsTakeEffect({
      forEachEvent: 'paid',
      eventKey: (e) => (e.json as { order: string }).order,
      effect: 'ship',
      key: (c) => c.body.order,
    });
    const obs = observations({
      events: evs.slice(0, 2),
      sink: [call(1, 'ship', { order: 'o1' }), call(2, 'ship', { order: 'o2' }, false)],
    });
    const v = await bySink.check(obs);
    expect(v.map((x) => x.message)).toEqual(['paid for o2 was acknowledged but ship never happened']);
  });

  it('rejects ambiguous options', () => {
    expect(() => eventsTakeEffect({ forEachEvent: 'x', eventKey: () => 'k' })).toThrow(/either `record`/);
    expect(() => eventsTakeEffect({ forEachEvent: 'x', eventKey: () => 'k', effect: 'e' })).toThrow(
      /needs `key`/,
    );
  });
});
