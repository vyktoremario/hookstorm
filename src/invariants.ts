import { isDeepStrictEqual } from 'node:util';
import type { Invariant, Observations, SinkCall, Violation, WebhookEvent } from './types.js';

export type CallKey = (call: SinkCall) => string | number | undefined | null;
export type EventKey = (event: WebhookEvent) => string | number | undefined | null;

const okCalls = (obs: Observations, effect: string) => obs.sink.filter((c) => c.ok && c.effect === effect);

function groupBy<T>(items: T[], key: (t: T) => string | number | undefined | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined || k === null) continue;
    const ks = String(k);
    const list = m.get(ks);
    if (list) list.push(item);
    else m.set(ks, [item]);
  }
  return m;
}

/**
 * The side effect happens at most once per key. Catches double charges, double fulfilment, duplicate emails.
 * Only successful sink calls count: a call the sink failed did not "happen".
 */
export function atMostOnce(effect: string, key: CallKey, description?: string): Invariant {
  const name = description ?? `${effect} happens at most once per key`;
  return {
    name,
    check(obs) {
      const out: Violation[] = [];
      for (const [k, calls] of groupBy(okCalls(obs, effect), key)) {
        if (calls.length > 1)
          out.push({
            invariant: name,
            key: k,
            message: `${effect} happened ${calls.length}× for ${k}`,
            sinkCalls: calls,
          });
      }
      return out;
    },
  };
}

export interface ExactlyOnceOptions {
  /** Which events must produce the effect: an event type, or a predicate. */
  forEachEvent: string | ((event: WebhookEvent) => boolean);
  /** Business key of an event; must match `key(call)` of the effect it should cause. */
  eventKey: EventKey;
  description?: string;
}

/**
 * Every acknowledged event of a kind produces the side effect exactly once. Catches lost events (the app said
 * 200 but the work never happened, so the provider will not retry) as well as duplicates.
 *
 * Events the provider never got a success for are skipped: from the provider's point of view they are still
 * pending, and a real provider would keep retrying for hours or days.
 */
export function exactlyOnce(effect: string, key: CallKey, opts: ExactlyOnceOptions): Invariant {
  const name = opts.description ?? `${effect} happens exactly once per acknowledged event`;
  const matches =
    typeof opts.forEachEvent === 'string'
      ? (e: WebhookEvent) => e.type === opts.forEachEvent
      : opts.forEachEvent;
  return {
    name,
    check(obs) {
      const byKey = groupBy(okCalls(obs, effect), key);
      const out: Violation[] = [];
      const expected = groupBy(
        obs.events.filter((e) => matches(e) && obs.isAcked(e.id)),
        opts.eventKey,
      );
      for (const [k, events] of expected) {
        const calls = byKey.get(k) ?? [];
        const eventIds = events.map((e) => e.id);
        if (calls.length === 0)
          out.push({
            invariant: name,
            key: k,
            eventIds,
            message: `${effect} never happened for ${k}, but the event was acknowledged, so the provider will not retry: event lost`,
          });
        else if (calls.length > 1)
          out.push({
            invariant: name,
            key: k,
            eventIds,
            sinkCalls: calls,
            message: `${effect} happened ${calls.length}× for ${k}`,
          });
      }
      return out;
    },
  };
}

export interface MonotonicOptions {
  /** Which entity a call is about, e.g. `(c) => c.body.orderId`. */
  key: CallKey;
  /** The state a call moves the entity to. Defaults to `call.body.status`. */
  state?: (call: SinkCall) => string | undefined;
  description?: string;
}

/** Recorded state transitions for each entity never move backwards through `order`. */
export function monotonic(effect: string, order: string[], opts: MonotonicOptions): Invariant {
  const name = opts.description ?? `${effect} never moves backwards through ${order.join(' → ')}`;
  const stateOf =
    opts.state ??
    ((c: SinkCall) => {
      const s = (c.body as Record<string, unknown> | undefined)?.status;
      return typeof s === 'string' ? s : undefined;
    });
  return {
    name,
    check(obs) {
      const out: Violation[] = [];
      for (const [k, calls] of groupBy(okCalls(obs, effect), opts.key)) {
        let maxRank = -1;
        let maxState = '';
        for (const c of calls) {
          const s = stateOf(c);
          const rank = s === undefined ? -1 : order.indexOf(s);
          if (rank === -1) continue;
          if (rank < maxRank) {
            out.push({
              invariant: name,
              key: k,
              sinkCalls: calls,
              message: `${k} went backwards: ${maxState} → ${s}`,
            });
            break;
          }
          if (rank > maxRank) {
            maxRank = rank;
            maxState = s!;
          }
        }
      }
      return out;
    },
  };
}

export type StateCheckResult = boolean | string | string[] | void | undefined;

/**
 * Checks the app's final state, read from the probe after the run settles. Return `true`/nothing for OK,
 * `false` for a violation, or one or more messages describing what is wrong.
 */
export function finalState(
  description: string,
  predicate: (state: any, obs: Observations) => StateCheckResult | Promise<StateCheckResult>, // eslint-disable-line @typescript-eslint/no-explicit-any
): Invariant {
  return {
    name: description,
    async check(obs) {
      if (obs.state === undefined)
        return [
          { invariant: description, message: 'no state snapshot: configure `probe` to use finalState()' },
        ];
      const result = await predicate(obs.state, obs);
      if (result === true || result === undefined || (Array.isArray(result) && result.length === 0))
        return [];
      if (result === false) return [{ invariant: description, message: description }];
      const messages = Array.isArray(result) ? result : [result];
      return messages.map((message) => ({ invariant: description, message }));
    },
  };
}

export type CustomResult = Array<string | Omit<Violation, 'invariant'>> | void | undefined;

/** Anything else: gets every observation, returns violation messages (or objects). */
export function custom(
  name: string,
  fn: (obs: Observations) => CustomResult | Promise<CustomResult>,
): Invariant {
  return {
    name,
    async check(obs) {
      const result = (await fn(obs)) ?? [];
      return result.map((r) =>
        typeof r === 'string' ? { invariant: name, message: r } : { ...r, invariant: name },
      );
    },
  };
}

export interface EventsTakeEffectOptions {
  /** Which events must have an effect: an event type, several types, or a predicate. */
  forEachEvent: string | string[] | ((event: WebhookEvent) => boolean);
  /** The record (or business key) an event is about, e.g. its order id. */
  eventKey: EventKey;
  /**
   * Probe mode: find that record in a probe snapshot. It must differ between the snapshot taken right after
   * `reset` and the one after the run. Return `undefined` if the record doesn't exist.
   */
  record?: (state: any, key: string) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Sink mode: the side effect the event must cause at least once, matched to the event by `key`. */
  effect?: string;
  key?: CallKey;
  description?: string;
}

/**
 * Every acknowledged event of a kind actually did something: its record changed, or its side effect happened.
 * Catches handlers that answer 200 but ignore the event, typically because `reset` didn't seed the record the
 * event refers to, so the app logs "unknown order" and moves on.
 *
 * Records are compared once per key, between the start and the end of the run. If two events touch the same
 * record (a payment and its refund), the rule holds as long as the record changed at all.
 */
export function eventsTakeEffect(opts: EventsTakeEffectOptions): Invariant {
  const probeMode = opts.record !== undefined;
  if (probeMode === (opts.effect !== undefined))
    throw new Error('eventsTakeEffect: pass either `record` (probe mode) or `effect` + `key` (sink mode)');
  if (!probeMode && !opts.key)
    throw new Error('eventsTakeEffect: `effect` needs `key` to match calls to events');
  const types = typeof opts.forEachEvent === 'string' ? [opts.forEachEvent] : opts.forEachEvent;
  const matches = Array.isArray(types) ? (e: WebhookEvent) => types.includes(e.type) : types;
  const what = Array.isArray(types) ? types.join(' / ') : 'matching';
  const name = opts.description ?? `every acknowledged ${what} event takes effect`;

  return {
    name,
    check(obs) {
      if (probeMode && (obs.state === undefined || obs.baseline === undefined))
        return [
          {
            invariant: name,
            message: 'no state snapshots: configure `probe` to use eventsTakeEffect({ record })',
          },
        ];
      const byKey = groupBy(
        obs.events.filter((e) => matches(e) && obs.isAcked(e.id)),
        (e) => opts.eventKey(e) ?? `(no key: ${e.id})`,
      );
      const out: Violation[] = [];
      for (const [k, events] of byKey) {
        const eventIds = events.map((e) => e.id);
        const label = [...new Set(events.map((e) => e.type))].join(' + ');
        if (k.startsWith('(no key: ')) {
          out.push({
            invariant: name,
            eventIds,
            message: `${label} ${eventIds.join(', ')}: eventKey returned nothing`,
          });
          continue;
        }
        if (probeMode) {
          const before = opts.record!(obs.baseline, k);
          const after = opts.record!(obs.state, k);
          if (before === undefined && after === undefined)
            out.push({
              invariant: name,
              key: k,
              eventIds,
              message: `${label} for ${k} was acknowledged, but ${k} doesn't exist: seed it in reset, or the event can't be tested`,
            });
          else if (isDeepStrictEqual(before, after))
            out.push({
              invariant: name,
              key: k,
              eventIds,
              message: `${label} for ${k} was acknowledged but changed nothing`,
            });
        } else if (!obs.sink.some((c) => c.ok && c.effect === opts.effect && String(opts.key!(c)) === k)) {
          out.push({
            invariant: name,
            key: k,
            eventIds,
            message: `${label} for ${k} was acknowledged but ${opts.effect} never happened`,
          });
        }
      }
      return out;
    },
  };
}
