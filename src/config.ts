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

/** Path of this package's entry, so configs can `import ... from 'hookstorm-cli'` without installing it. */
function selfEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = extname(here); // .ts when running from source, .js from dist
  const candidates = [resolve(dirname(here), `index${ext}`), resolve(dirname(here), '../index.js')];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
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
    invariants: config.invariants,
  };
}
