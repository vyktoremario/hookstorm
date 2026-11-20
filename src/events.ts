import { readFile } from 'node:fs/promises';
import type { WebhookEvent } from './types.js';

/** Shape of one fixture line (JSONL) or one inline event in the config. */
export interface EventInput {
  id?: string;
  type?: string;
  /** Raw body string (preferred, signed byte-for-byte) or an object (serialised once with JSON.stringify). */
  body: string | Record<string, unknown>;
  headers?: Record<string, string>;
}

export function normaliseEvents(inputs: EventInput[], source = 'config'): WebhookEvent[] {
  const seen = new Set<string>();
  return inputs.map((input, i) => {
    if (input === null || typeof input !== 'object' || input.body === undefined) {
      throw new Error(`${source}: event #${i + 1} must be an object with a "body"`);
    }
    const body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    const headers = Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const id = input.id ?? `evt_${i + 1}`;
    if (seen.has(id)) throw new Error(`${source}: duplicate event id "${id}"`);
    seen.add(id);
    return { id, type: input.type ?? inferType(json, headers), body, headers, json };
  });
}

function inferType(json: unknown, headers: Record<string, string>): string {
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (typeof o.type === 'string') return o.type; // Stripe
    if (typeof o.event === 'string') return o.event; // Paystack
  }
  return headers['x-github-event'] ?? 'unknown';
}

export function parseJsonl(text: string, source: string): EventInput[] {
  const out: EventInput[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return;
    try {
      out.push(JSON.parse(trimmed) as EventInput);
    } catch (err) {
      throw new Error(`${source}:${i + 1}: invalid JSON (${(err as Error).message})`, { cause: err });
    }
  });
  return out;
}

export async function loadEventsFile(path: string): Promise<WebhookEvent[]> {
  const text = await readFile(path, 'utf8');
  const events = normaliseEvents(parseJsonl(text, path), path);
  if (events.length === 0) throw new Error(`${path}: no events found`);
  return events;
}
