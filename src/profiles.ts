/** Probabilities and timings that drive the scenario engine. */
export interface FaultProfile {
  /** Chance an event gets an extra, later delivery (provider at-least-once). */
  duplicate: number;
  /** Chance an event gets an extra delivery fired in parallel with the first. */
  concurrent: number;
  /** Events may move up to `reorderWindow - 1` positions. 0 or 1 disables reordering. */
  reorderWindow: number;
  /** Chance a delivery is held back, and the max hold time. */
  delay: number;
  delayMaxMs: number;
  /** Per-attempt fault chances (they are mutually exclusive). */
  dropRequest: number;
  dropResponse: number;
  timeout: number;
  /** Gap between consecutive events, and range of the gap before a sequential duplicate. */
  spacingMs: number;
  duplicateGapMs: [number, number];
}

export type ProfileName = 'gentle' | 'realistic' | 'hostile';

export const PROFILES: Record<ProfileName, FaultProfile> = {
  gentle: {
    duplicate: 0.1,
    concurrent: 0,
    reorderWindow: 0,
    delay: 0.1,
    delayMaxMs: 100,
    dropRequest: 0.05,
    dropResponse: 0.05,
    timeout: 0,
    spacingMs: 25,
    duplicateGapMs: [50, 200],
  },
  realistic: {
    duplicate: 0.25,
    concurrent: 0.15,
    reorderWindow: 3,
    delay: 0.2,
    delayMaxMs: 250,
    dropRequest: 0.1,
    dropResponse: 0.15,
    timeout: 0.05,
    spacingMs: 25,
    duplicateGapMs: [30, 300],
  },
  hostile: {
    duplicate: 0.5,
    concurrent: 0.35,
    reorderWindow: 5,
    delay: 0.4,
    delayMaxMs: 500,
    dropRequest: 0.2,
    dropResponse: 0.25,
    timeout: 0.15,
    spacingMs: 15,
    duplicateGapMs: [10, 400],
  },
};

export type ProfileInput = ProfileName | (Partial<FaultProfile> & { extends?: ProfileName });

export function resolveProfile(input: ProfileInput | undefined): { name: string; profile: FaultProfile } {
  if (input === undefined) return { name: 'realistic', profile: PROFILES.realistic };
  if (typeof input === 'string') {
    const p = PROFILES[input];
    if (!p) throw new Error(`Unknown profile "${input}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
    return { name: input, profile: p };
  }
  const { extends: base = 'realistic', ...overrides } = input;
  const p = PROFILES[base];
  if (!p) throw new Error(`Unknown base profile "${base}"`);
  const profile = { ...p, ...overrides };
  const perAttempt = profile.dropRequest + profile.dropResponse + profile.timeout;
  if (perAttempt > 1) throw new Error('dropRequest + dropResponse + timeout must be <= 1');
  return { name: `${base}+custom`, profile };
}
