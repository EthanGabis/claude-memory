// processor/belief-utils.ts — Belief system utility functions

import { randomUUID } from 'crypto';

/** Generate a belief ID in the same format as episode IDs */
export function generateBeliefId(): string {
  return 'bl_' + randomUUID().replace(/-/g, '').slice(0, 20);
}

/** Compute confidence as mean of Beta(alpha, beta) distribution */
export function beliefConfidence(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/** Compute retrieval strength using exponential decay (Bjork dual-strength model) */
export function retrievalStrength(lastAccessedAt: number | null, stability: number, now: number): number {
  if (!lastAccessedAt) return 0.5; // never accessed = neutral
  const hoursSinceAccess = (now - lastAccessedAt) / (1000 * 60 * 60);
  return Math.exp(-hoursSinceAccess / (stability * 24)); // stability in days
}

/** Update stability after retrieval (spaced repetition bonus, capped at 365 days) */
export function updateStability(currentStability: number, lastAccessedAt: number | null, now: number): number {
  if (!lastAccessedAt) return currentStability;
  const hoursSinceLastAccess = (now - lastAccessedAt) / (1000 * 60 * 60);
  const newStability = currentStability * (1 + 0.1 * Math.log(1 + hoursSinceLastAccess / 24));
  return Math.min(newStability, 365);
}

/** Compute destabilization threshold (old, well-evidenced beliefs resist change) */
export function destabilizationThreshold(evidenceCount: number, createdAt: number, now: number): number {
  const BASE = 0.3;
  const evidenceFactor = Math.log(1 + evidenceCount);
  const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
  const ageFactor = Math.log(1 + ageDays);
  return BASE * evidenceFactor * ageFactor;
}

/** Check if a belief should be archived */
export function shouldArchive(
  alpha: number,
  beta: number,
  lastReinforcedAt: number | null,
  evidenceCount: number,
  now: number,
  createdAt: number,
): boolean {
  const confidence = beliefConfidence(alpha, beta);
  if (confidence < 0.3) return true;
  const referenceTime = lastReinforcedAt ?? createdAt;
  const daysSinceReinforced = (now - referenceTime) / (1000 * 60 * 60 * 24);
  if (daysSinceReinforced > 90 && evidenceCount < 5) return true;
  // Long-stale beliefs with mediocre confidence should eventually archive
  if (confidence < 0.5 && daysSinceReinforced > 180) return true;
  return false;
}

/** Check if a belief should trigger revision */
export function shouldRevise(
  alpha: number,
  beta: number,
  contradictingCount: number,
  evidenceCount: number,
  previousConfidence: number,
): boolean {
  const confidence = beliefConfidence(alpha, beta);
  return confidence < 0.4 && previousConfidence > 0.5 && contradictingCount >= 3 && evidenceCount >= 5;
}

/** Check if a belief should split */
export function shouldSplit(
  supportingCount: number,
  contradictingCount: number,
  partialCount: number,
  evidenceCount: number,
): boolean {
  return (
    contradictingCount >= 3 &&
    supportingCount >= 3 &&
    partialCount >= 2 &&
    evidenceCount >= 5
  );
}

/** Check if two beliefs should merge */
export function shouldMerge(
  cosineSim: number,
  sameScope: boolean,
  confidenceA: number,
  confidenceB: number,
  updatedAtA: number,
  updatedAtB: number,
  now: number,
): boolean {
  const cooldownMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  return (
    cosineSim > 0.92 &&
    sameScope &&
    confidenceA > 0.6 &&
    confidenceB > 0.6 &&
    (now - updatedAtA) > cooldownMs &&
    (now - updatedAtB) > cooldownMs
  );
}

// Configuration constants
export const BELIEF_CONFIG = {
  // Consolidation triggers
  EPISODE_THRESHOLD: 20,
  MIN_CLUSTER_SIZE: 3,
  CLUSTER_SIMILARITY_THRESHOLD: 0.70,

  // Belief matching
  REINFORCE_THRESHOLD: 0.92,
  RELATED_THRESHOLD: 0.70,

  // Confidence gates
  MIN_CONFIDENCE_FOR_RECALL: 0.4,
  REVISION_CONFIDENCE_THRESHOLD: 0.4,
  ARCHIVE_CONFIDENCE_THRESHOLD: 0.3,

  // Rule-based gates
  SPLIT_MIN_CONTRADICTIONS: 3,
  SPLIT_MIN_SUPPORTS: 3,
  SPLIT_MIN_PARTIAL_COUNT: 2,
  SPLIT_MIN_EVIDENCE: 5,
  MERGE_MIN_SIMILARITY: 0.92,
  MERGE_MIN_CONFIDENCE: 0.6,
  MERGE_COOLDOWN_DAYS: 7,

  // Decay
  ARCHIVE_STALE_DAYS: 90,
  ARCHIVE_MIN_EVIDENCE: 5,

  // Stability
  DEFAULT_STABILITY: 7.0,

  // Retrieval
  MAX_BELIEF_BITES: 2,

  // Budget
  MAX_CLUSTERS_PER_CYCLE: 10,
  MAX_CLASSIFICATIONS_PER_CLUSTER: 5,
  PER_CALL_TIMEOUT_MS: 10_000,
  MAX_CYCLE_BUDGET_MS: 120_000,

  // LLM
  SYNTHESIS_MODEL: 'gpt-4.1-mini',
  CLASSIFICATION_MODEL: 'gpt-4.1-mini',
} as const;
