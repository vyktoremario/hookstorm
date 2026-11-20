import http from 'node:http';
import https from 'node:https';
import type { ProviderPreset } from './presets.js';
import type {
  AttemptFault,
  AttemptRecord,
  DeliveryPlan,
  DeliveryRecord,
  PlannedDelivery,
  WebhookEvent,
} from './types.js';

export interface SimulatorOptions {
  target: string;
  preset: ProviderPreset;
  secret: string;
  /** Per-attempt response timeout. */
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number[];
  /** performance.now() at run start; all recorded times are relative to it. */
  t0: number;
  now?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Plays a delivery plan against the target, acting as the provider (ADR-0001). */
export async function executePlan(
  plan: DeliveryPlan,
  events: Map<string, WebhookEvent>,
  opts: SimulatorOptions,
): Promise<DeliveryRecord[]> {
  return Promise.all(
    plan.deliveries.map((d) => {
      const event = events.get(d.eventId);
      if (!event) throw new Error(`Plan references unknown event ${d.eventId}`);
      return runDelivery(d, event, opts);
    }),
  );
}

async function runDelivery(d: PlannedDelivery, event: WebhookEvent, opts: SimulatorOptions) {
  const now = opts.now ?? (() => performance.now());
  const rec: DeliveryRecord = {
    deliveryId: d.deliveryId,
    eventId: d.eventId,
    copy: d.copy,
    attempts: [],
    acked: false,
  };
  const waitUntil = opts.t0 + d.startAtMs + d.delayMs;
  await sleep(waitUntil - now());

  const attempts = Math.min(d.faults.length, opts.maxAttempts);
  for (let i = 0; i < attempts; i++) {
    const fault = d.faults[i] ?? { kind: 'none' };
    const a = await attempt(d, event, i + 1, fault, opts);
    rec.attempts.push(a);
    if (a.outcome === 'acked') {
      rec.acked = true;
      break;
    }
    if (i < attempts - 1) {
      const wait = opts.backoffMs[i] ?? opts.backoffMs[opts.backoffMs.length - 1] ?? 0;
      await sleep(wait);
    }
  }
  return rec;
}

async function attempt(
  d: PlannedDelivery,
  event: WebhookEvent,
  n: number,
  fault: AttemptFault,
  opts: SimulatorOptions,
): Promise<AttemptRecord> {
  const now = opts.now ?? (() => performance.now());
  const startedAt = now() - opts.t0;
  const base = { deliveryId: d.deliveryId, eventId: d.eventId, attempt: n, fault: fault.kind, startedAt };

  if (fault.kind === 'dropRequest') {
    return { ...base, endedAt: startedAt, outcome: 'notSent' };
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers)) {
    if (!opts.preset.stripHeaders.includes(k)) headers[k] = v;
  }
  Object.assign(
    headers,
    {
      'content-type': headers['content-type'] ?? 'application/json',
      'user-agent': 'hookstorm',
      'x-hookstorm-event': event.id,
      'x-hookstorm-delivery': d.deliveryId,
      'x-hookstorm-attempt': String(n),
    },
    opts.preset.sign({
      body: event.body,
      secret: opts.secret,
      event,
      attempt: n,
      nowSec: Math.floor(Date.now() / 1000),
    }),
  );

  const res = await post(opts.target, event.body, headers, {
    timeoutMs: opts.timeoutMs,
    abortAfterSendMs: fault.kind === 'timeout' ? (fault.abortAfterMs ?? 10) : undefined,
  });
  const endedAt = now() - opts.t0;
  switch (res.kind) {
    case 'response':
      if (fault.kind === 'dropResponse')
        return { ...base, endedAt, status: res.status, outcome: 'responseDropped' };
      return {
        ...base,
        endedAt,
        status: res.status,
        outcome: opts.preset.isSuccess(res.status) ? 'acked' : 'rejected',
      };
    case 'timeout':
      return { ...base, endedAt, outcome: 'timedOut' };
    case 'aborted':
      return { ...base, endedAt, outcome: 'aborted' };
    case 'error':
      return { ...base, endedAt, outcome: 'error', error: res.message };
  }
}

type PostResult =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

/** Minimal HTTP POST with a response timeout and an optional "cut the connection after sending" abort. */
export function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; abortAfterSendMs?: number | undefined },
): Promise<PostResult> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    let abortTimer: NodeJS.Timeout | undefined;
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      agent: false,
    });
    const done = (r: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(abortTimer);
      resolve(r);
    };
    const timeoutTimer = setTimeout(() => {
      done({ kind: 'timeout' });
      req.destroy();
    }, opts.timeoutMs);
    req.on('finish', () => {
      if (opts.abortAfterSendMs === undefined) return;
      abortTimer = setTimeout(() => {
        done({ kind: 'aborted' });
        req.destroy();
      }, opts.abortAfterSendMs);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        done({ kind: 'response', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', (e) => done({ kind: 'error', message: e.message }));
    });
    req.on('error', (e) => done({ kind: 'error', message: e.message }));
    req.end(body);
  });
}
