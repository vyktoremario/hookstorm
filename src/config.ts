import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { type EventInput, loadEventsFile, normaliseEvents } from './events.js';
import { getPreset, type ProviderName, type ProviderPreset } from './presets.js';
import { type FaultProfile, type ProfileInput, resolveProfile } from './profiles.js';
import type { SinkFaultsInput } from './sink.js';
import type { Invariant, Signer, WebhookEvent } from './types.js';

export interface HookstormConfig {
  /** URL of the webhook endpoint under test. */
  target: string;
  provider: ProviderName;
  /** Test-mode webhook secret your local app verifies with. Never a production secret. */
  secret?: string;
  /** Signer for `provider: 'custom'`. */
  sign?: Signer;
  /** Path to a JSONL fixture (relative to the config file) or inline events. */
  events: string | EventInput[];
  profile?: ProfileInput;
  /** Override the preset's attempts per delivery. */
  maxAttempts?: number;
  /** Override the preset's compressed backoff. */
  backoffMs?: number[];
  /**
   * Per-attempt response timeout in ms (default 1000). Deliberately much stricter than production
   * (Stripe/Paystack/GitHub allow 10–30 s) to surface slow work done before the ack.
   */
  timeoutMs?: number;
  /** Wait after the last delivery before probing state and checking invariants (default 500). */
  settleMs?: number;
  sink?: { port?: number; host?: string; faults?: SinkFaultsInput };
  /** Called before each run so state does not leak between seeds: a URL (POSTed) or a function. */
  reset?: string | (() => unknown);
  /** Where to read the app's state after a run: a URL (GET, JSON) or a function. */
  probe?: string | (() => unknown);
  /**
   * Event types your app receives but doesn't act on (e.g. `payment_intent.created`). They are still delivered
   * with faults, but left out of violation timelines so the cause is easier to see.
   */
  ignoredEventTypes?: string[];
  /** Business key of an event (e.g. payment reference). Used to show the timeline behind a violation. */
  eventKey?: (event: WebhookEvent) => string | number | undefined | null;
  invariants: Invariant[];
}

export function defineConfig(config: HookstormConfig): HookstormConfig {
  return config;
}

export interface ResolvedConfig {
  configPath: string | undefined;
  target: string;
  preset: ProviderPreset;
  secret: string;
  events: WebhookEvent[];
  profileName: string;
  profile: FaultProfile;
  maxAttempts: number;
  backoffMs: number[];
  timeoutMs: number;
  settleMs: number;
  sinkPort: number;
  sinkHost: string;
  sinkFaults: SinkFaultsInput;
  reset: HookstormConfig['reset'];
  probe: HookstormConfig['probe'];
  eventKey: (event: WebhookEvent) => string | undefined;
  ignoredEventTypes: string[];
  invariants: Invariant[];
}

export interface ConfigOverrides {
  target?: string;
  profile?: ProfileInput;
  timeoutMs?: number;
  settleMs?: number;
  sinkPort?: number;
  maxAttempts?: number;
}

export class ConfigError extends Error {}

const KNOWN_KEYS = [
  'target',
  'provider',
  'secret',
  'sign',
  'events',
  'profile',
  'maxAttempts',
  'backoffMs',
  'timeoutMs',
  'settleMs',
  'sink',
  'reset',
  'probe',
  'ignoredEventTypes',
  'eventKey',
  'invariants',
] as const satisfies ReadonlyArray<keyof HookstormConfig>;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

/** A typo in a config key would otherwise be silently ignored, e.g. `ignoreEventTypes`. */
function unknownKeyMessage(key: string): string {
  const best = [...KNOWN_KEYS].sort((x, y) => editDistance(key, x) - editDistance(key, y))[0]!;
  const hint = editDistance(key, best) <= 3 ? ` Did you mean \`${best}\`?` : '';
  return `unknown config key \`${key}\`.${hint}`;
}

/** Path of this package's entry, so configs can `import ... from 'hookstorm-cli'` without installing it. */
function selfEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = extname(here); // .ts when running from source, .js from dist
  const candidates = [resolve(dirname(here), `index${ext}`), resolve(dirname(here), '../index.js')];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

/**
 * Loads environment variables for the config, so `secret: process.env.X` can read the same `.env` the app uses.
 * `envFile`: `undefined` = `.env` next to the config if it exists; a path = that file (must exist);
 * `false` = load nothing. Variables already set in the shell always win. Returns the file loaded, if any.
 */
export function loadEnvForConfig(
  configPath: string,
  envFile: string | false | undefined,
): string | undefined {
  if (envFile === false) return undefined;
  const path = envFile === undefined ? resolve(dirname(resolve(configPath)), '.env') : resolve(envFile);
  if (!existsSync(path)) {
    if (envFile !== undefined) throw new ConfigError(`env file not found: ${path}`);
    return undefined;
  }
  process.loadEnvFile(path);
  return path;
}

export async function loadConfigFile(path: string): Promise<HookstormConfig> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new ConfigError(`Config not found: ${abs}`);
  const jiti = createJiti(import.meta.url, { alias: { 'hookstorm-cli': selfEntry() }, moduleCache: false });
  const mod = await jiti.import<HookstormConfig | { default: HookstormConfig }>(abs, { default: true });
  return (
    'default' in (mod as object) ? (mod as { default: HookstormConfig }).default : mod
  ) as HookstormConfig;
}

export async function resolveConfig(
  config: HookstormConfig,
  configPath?: string,
  overrides: ConfigOverrides = {},
): Promise<ResolvedConfig> {
  const fail = (msg: string): never => {
    throw new ConfigError(`${configPath ?? 'config'}: ${msg}`);
  };
  if (!config || typeof config !== 'object') fail('must export a config object (use defineConfig)');
  for (const key of Object.keys(config))
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) fail(unknownKeyMessage(key));
  if (
    config.ignoredEventTypes !== undefined &&
    (!Array.isArray(config.ignoredEventTypes) || config.ignoredEventTypes.some((t) => typeof t !== 'string'))
  )
    fail('`ignoredEventTypes` must be an array of event type strings');
  const target = overrides.target ?? config.target;
  if (!target) fail('`target` is required (or pass --target)');
  try {
    new URL(target);
  } catch {
    fail(`invalid target URL "${target}"`);
  }
  if (!config.provider) fail('`provider` is required: stripe | paystack | github | custom');
  const preset = getPreset(config.provider, config.sign);
  if (config.provider === 'custom' && !config.sign) fail('`sign` is required when provider is "custom"');
  const secret = config.secret ?? '';
  if (config.provider !== 'custom' && !secret)
    fail('`secret` is required: use the test-mode webhook secret your local app is configured with');
  if (!Array.isArray(config.invariants) || config.invariants.length === 0)
    fail('`invariants` must list at least one invariant');
  for (const inv of config.invariants)
    if (!inv || typeof inv.check !== 'function') fail('every invariant must come from a hookstorm helper');

  const baseDir = configPath ? dirname(resolve(configPath)) : process.cwd();
  let events: WebhookEvent[];
  if (typeof config.events === 'string') {
    const p = isAbsolute(config.events) ? config.events : resolve(baseDir, config.events);
    if (!existsSync(p)) fail(`events file not found: ${p}`);
    events = await loadEventsFile(p);
  } else if (Array.isArray(config.events)) {
    events = normaliseEvents(config.events);
  } else {
    return fail('`events` must be a JSONL path or an array of events');
  }

  let profileResolved: ReturnType<typeof resolveProfile>;
  try {
    profileResolved = resolveProfile(overrides.profile ?? config.profile);
  } catch (e) {
    return fail((e as Error).message);
  }

  // `reset`/`probe` may be paths ("/hookstorm/state"), resolved against the target's origin, so `--target`
  // moves them along with it.
  const origin = new URL(target!).origin;
  const rel = <T>(hook: T): T =>
    typeof hook === 'string' && hook.startsWith('/') ? (`${origin}${hook}` as T) : hook;

  const userKey = config.eventKey;
  return {
    configPath,
    target: target!,
    preset,
    secret,
    events,
    profileName: profileResolved.name,
    profile: profileResolved.profile,
    maxAttempts: overrides.maxAttempts ?? config.maxAttempts ?? preset.maxAttempts,
    backoffMs: config.backoffMs ?? preset.backoffMs,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs ?? 1000,
    settleMs: overrides.settleMs ?? config.settleMs ?? 500,
    sinkPort: overrides.sinkPort ?? config.sink?.port ?? 4400,
    sinkHost: config.sink?.host ?? '127.0.0.1',
    sinkFaults: config.sink?.faults ?? {},
    reset: rel(config.reset),
    probe: rel(config.probe),
    eventKey: (e) => {
      const k = userKey ? userKey(e) : preset.eventKey(e);
      return k === undefined || k === null ? undefined : String(k);
    },
    ignoredEventTypes: config.ignoredEventTypes ?? [],
    invariants: config.invariants,
  };
}
