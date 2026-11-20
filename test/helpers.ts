import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { normaliseEvents } from '../src/events.js';
import type { DeliveryPlan, Observations, SinkCall, WebhookEvent } from '../src/types.js';

export async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface FakeRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
  at: number;
}

/** A scripted receiver for simulator tests. */
export async function fakeReceiver(
  respond: (req: FakeRequest, n: number) => { status?: number; delayMs?: number } = () => ({}),
) {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r = { headers: req.headers, body: Buffer.concat(chunks).toString(), at: performance.now() };
      requests.push(r);
      const { status = 200, delayMs = 0 } = respond(r, requests.length);
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(status).end('ok');
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Starts one of the example receivers on a free port, pointed at a given sink. */
export async function startExample(
  which: 'buggy' | 'fixed',
  sinkPort: number,
): Promise<{ port: number; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [`examples/${which}-receiver/server.mjs`], {
    env: { ...process.env, PORT: String(port), SINK_URL: `http://127.0.0.1:${sinkPort}/sink` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    proc.once('exit', (code) => reject(new Error(`${which} receiver exited with ${code}`)));
    proc.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) resolve();
    });
  });
  return { port, proc };
}

export function events(...bodies: Array<Record<string, unknown>>): WebhookEvent[] {
  return normaliseEvents(bodies.map((body, i) => ({ id: `e${i + 1}`, body })));
}

export function call(seq: number, effect: string, body: unknown, ok = true): SinkCall {
  return {
    seq,
    effect,
    at: seq,
    method: 'POST',
    body,
    raw: JSON.stringify(body),
    headers: {},
    status: ok ? 200 : 503,
    ok,
  };
}

export function observations(partial: Partial<Observations> & { acked?: string[] }): Observations {
  const plan: DeliveryPlan = { seed: 1, profile: 'test', order: [], deliveries: [] };
  const acked = new Set(partial.acked ?? (partial.events ?? []).map((e) => e.id));
  return {
    seed: 1,
    events: [],
    plan,
    deliveries: [],
    sink: [],
    state: undefined,
    baseline: undefined,
    isAcked: (id) => acked.has(id),
    ...partial,
  };
}
