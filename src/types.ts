/** A webhook event loaded from a fixture. `body` holds the exact bytes that will be sent and signed. */
export interface WebhookEvent {
  /** Fixture-level id, unique within a fixture file. */
  id: string;
  /** Event type, e.g. `charge.success` or `payment_intent.succeeded`. */
  type: string;
  /** Raw request body, sent byte-for-byte (see ADR-0005). */
  body: string;
  /** Extra non-signature headers to send with every attempt. */
  headers: Record<string, string>;
  /** `body` parsed as JSON (or `undefined` if it is not JSON). Typed loosely so key functions stay short. */
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type FaultKind = 'none' | 'dropRequest' | 'dropResponse' | 'timeout';

export interface AttemptFault {
  kind: FaultKind;
  /** For `timeout`: abort this many ms after the request has been fully sent. */
  abortAfterMs?: number;
}

/** One provider delivery of an event (the original or a duplicate), with its retries pre-planned. */
export interface PlannedDelivery {
  deliveryId: string;
  eventId: string;
  /** 0 = original delivery, 1+ = duplicate deliveries of the same event. */
  copy: number;
  startAtMs: number;
  delayMs: number;
  /** Set when this duplicate is fired in parallel with another delivery. */
  concurrentWith?: string;
  /** Fault for each attempt; its length is the max number of attempts. */
  faults: AttemptFault[];
}

export interface DeliveryPlan {
  seed: number;
  profile: string;
  /** Event ids in the order they are first sent. */
  order: string[];
  deliveries: PlannedDelivery[];
}

export type AttemptOutcome =
  | 'acked' // app answered with a status the provider counts as success
  | 'rejected' // app answered with a non-success status
  | 'notSent' // dropRequest: provider thinks it sent, app never saw it
  | 'responseDropped' // app answered, provider never saw the answer
  | 'timedOut' // app did not answer within timeoutMs
  | 'aborted' // timeout fault: connection cut shortly after sending
  | 'error'; // connection error (e.g. app not running)

export interface AttemptRecord {
  deliveryId: string;
  eventId: string;
  attempt: number;
  fault: FaultKind;
  /** ms since run start */
  startedAt: number;
  endedAt: number;
  status?: number;
  outcome: AttemptOutcome;
  error?: string;
}

export interface DeliveryRecord {
  deliveryId: string;
  eventId: string;
  copy: number;
  attempts: AttemptRecord[];
  /** The provider saw a success response for some attempt, so it stops retrying. */
  acked: boolean;
}

/** A side effect the app performed, recorded by the sink. */
export interface SinkCall {
  seq: number;
  effect: string;
  /** ms since run start */
  at: number;
  method: string;
  /** Parsed JSON body (or the raw string). Typed loosely so key functions stay short: `(c) => c.body.ref`. */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  raw: string;
  headers: Record<string, string>;
  /** Status the sink answered with. Failed calls (injected faults) did not "happen". */
  status: number;
  ok: boolean;
}

export interface Observations {
  seed: number;
  events: WebhookEvent[];
  plan: DeliveryPlan;
  deliveries: DeliveryRecord[];
  /** All sink calls, including failed ones (check `ok`). */
  sink: SinkCall[];
  /** Snapshot from the probe, if configured. Typed loosely so invariants can read it directly. */
  state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Probe snapshot taken right after `reset`, before any event was delivered. */
  baseline: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** True when the provider received a success for at least one delivery of the event. */
  isAcked(eventId: string): boolean;
}

export interface Violation {
  invariant: string;
  message: string;
  /** Business key the violation is about (e.g. a payment reference). */
  key?: string;
  sinkCalls?: SinkCall[];
  eventIds?: string[];
}

export interface Invariant {
  name: string;
  check(obs: Observations): Violation[] | Promise<Violation[]>;
}

export interface SignInput {
  body: string;
  secret: string;
  event: WebhookEvent;
  attempt: number;
  /** Unix seconds at send time. */
  nowSec: number;
}

export type Signer = (input: SignInput) => Record<string, string>;
