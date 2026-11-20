import { Rng } from './prng.js';
import type { FaultProfile } from './profiles.js';
import type { AttemptFault, DeliveryPlan, PlannedDelivery } from './types.js';

export interface PlanInput {
  eventIds: string[];
  profile: FaultProfile;
  profileName: string;
  seed: number;
  maxAttempts: number;
}

/**
 * Pure function: (events, profile, seed) -> delivery plan. Every random decision is taken here, in a fixed
 * order, so the same inputs always produce the same plan (ADR-0004).
 */
export function buildPlan({ eventIds, profile, profileName, seed, maxAttempts }: PlanInput): DeliveryPlan {
  if (maxAttempts < 1) throw new Error('maxAttempts must be >= 1');
  const rng = new Rng(seed);

  const order = [...eventIds];
  if (profile.reorderWindow > 1) {
    for (let i = 0; i < order.length - 1; i++) {
      const j = i + rng.int(0, Math.min(profile.reorderWindow - 1, order.length - 1 - i));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
  }

  const faultsFor = (): AttemptFault[] => {
    const faults: AttemptFault[] = [];
    for (let k = 0; k < maxAttempts; k++) {
      const r = rng.float();
      // With retries available, the final attempt is always clean so the scenario models a provider that
      // eventually gets through. With a single attempt (e.g. GitHub), losses are real and allowed.
      if (maxAttempts > 1 && k === maxAttempts - 1) {
        faults.push({ kind: 'none' });
        continue;
      }
      if (r < profile.dropRequest) faults.push({ kind: 'dropRequest' });
      else if (r < profile.dropRequest + profile.dropResponse) faults.push({ kind: 'dropResponse' });
      else if (r < profile.dropRequest + profile.dropResponse + profile.timeout)
        faults.push({ kind: 'timeout', abortAfterMs: rng.int(2, 30) });
      else faults.push({ kind: 'none' });
    }
    return faults;
  };

  const deliveries: PlannedDelivery[] = [];
  order.forEach((eventId, pos) => {
    const startAtMs = pos * profile.spacingMs;
    const delayMs = rng.chance(profile.delay) ? rng.int(1, profile.delayMaxMs) : 0;
    const original: PlannedDelivery = {
      deliveryId: `${eventId}#0`,
      eventId,
      copy: 0,
      startAtMs,
      delayMs,
      faults: faultsFor(),
    };
    deliveries.push(original);
    let copy = 1;
    if (rng.chance(profile.duplicate)) {
      const gap = rng.int(profile.duplicateGapMs[0], profile.duplicateGapMs[1]);
      deliveries.push({
        deliveryId: `${eventId}#${copy}`,
        eventId,
        copy: copy++,
        startAtMs: startAtMs + delayMs + gap,
        delayMs: 0,
        faults: faultsFor(),
      });
    }
    if (rng.chance(profile.concurrent)) {
      deliveries.push({
        deliveryId: `${eventId}#${copy}`,
        eventId,
        copy,
        startAtMs: startAtMs + delayMs,
        delayMs: 0,
        concurrentWith: original.deliveryId,
        faults: faultsFor(),
      });
    }
  });

  return { seed, profile: profileName, order, deliveries };
}

export function describeFaults(plan: DeliveryPlan): Record<string, number> {
  const counts: Record<string, number> = {
    deliveries: plan.deliveries.length,
    duplicates: 0,
    concurrent: 0,
    delayed: 0,
    dropRequest: 0,
    dropResponse: 0,
    timeout: 0,
  };
  for (const d of plan.deliveries) {
    if (d.copy > 0 && !d.concurrentWith) counts.duplicates!++;
    if (d.concurrentWith) counts.concurrent!++;
    if (d.delayMs > 0) counts.delayed!++;
    for (const f of d.faults) if (f.kind !== 'none') counts[f.kind]!++;
  }
  return counts;
}
