import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashString, mulberry32 } from './prng.js';
import type { SinkCall } from './types.js';

export interface SinkFault {
  /** Chance a call to this effect fails with `status`. */
  failRate: number;
  /** Never fail the same logical call more than this many times in a row (default 2). */
  maxConsecutive?: number;
  status?: number;
}

export type SinkFaultsInput = Record<string, number | SinkFault>;

/**
 * Records side effects the app performs (ADR-0002). The app calls `POST {sink}/<effect>` wherever it would
 * charge a card, ship an order or send an email. Calls can be failed on purpose to test the app's own retry
 * and error handling. Failures are derived from (seed, effect, body, occurrence), so they don't depend on
 * arrival order.
 */
export class SinkServer {
  calls: SinkCall[] = [];
  private server: http.Server | undefined;
  private seed = 0;
  private t0 = performance.now();
  private occurrences = new Map<string, number>();
  private consecutive = new Map<string, number>();
  private faults: Record<string, SinkFault>;

  constructor(faults: SinkFaultsInput = {}) {
    this.faults = Object.fromEntries(
      Object.entries(faults).map(([k, v]) => [k, typeof v === 'number' ? { failRate: v } : v]),
    );
  }

  get url(): string {
    const addr = this.server?.address() as AddressInfo | null | undefined;
    if (!addr) throw new Error('sink not started');
    return `http://127.0.0.1:${addr.port}/sink`;
  }

  async start(port = 4400, host = '127.0.0.1'): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  /** Start a new run: forget previous calls and fault state. */
  reset(seed: number, t0 = performance.now()): void {
    this.calls = [];
    this.seed = seed;
    this.t0 = t0;
    this.occurrences.clear();
    this.consecutive.clear();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://sink');
    if (req.method === 'GET' && url.pathname === '/sink/_calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.calls));
      return;
    }
    const m = /^\/sink\/(.+)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end('hookstorm sink: POST /sink/<effect>');
      return;
    }
    const effect = decodeURIComponent(m[1]!).replace(/\//g, '.');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        /* keep raw string */
      }
      const status = this.decide(effect, raw);
      const call: SinkCall = {
        seq: this.calls.length + 1,
        effect,
        at: performance.now() - this.t0,
        method: req.method ?? 'POST',
        body,
        raw,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
        ),
        status,
        ok: status < 400,
      };
      this.calls.push(call);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(call.ok ? { ok: true, seq: call.seq } : { ok: false, error: 'injected by hookstorm' }),
      );
    });
  }

  private decide(effect: string, raw: string): number {
    const fault = this.faults[effect];
    if (!fault || fault.failRate <= 0) return 200;
    const key = `${effect}\u0000${raw}`;
    const n = this.occurrences.get(key) ?? 0;
    this.occurrences.set(key, n + 1);
    const streak = this.consecutive.get(key) ?? 0;
    const roll = mulberry32(hashString(`${this.seed}\u0000${key}\u0000${n}`))();
    const fail = streak < (fault.maxConsecutive ?? 2) && roll < fault.failRate;
    this.consecutive.set(key, fail ? streak + 1 : 0);
    return fail ? (fault.status ?? 503) : 200;
  }
}
