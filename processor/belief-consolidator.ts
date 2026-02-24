// processor/belief-consolidator.ts — Core belief consolidation pipeline
//
// Extracts generalized beliefs from episode clusters using the
// Complementary Learning Systems model: episodes (hippocampus) →
// beliefs (neocortex) via batch consolidation.

import { Database } from 'bun:sqlite';
import type OpenAI from 'openai';
import type { Belief } from '../mcp/schema.js';
import { cosineSimilarity, packEmbedding, unpackEmbedding } from '../mcp/embeddings.js';
import {
  generateBeliefId,
  beliefConfidence,
  shouldArchive,
  shouldRevise,
  shouldSplit,
  shouldMerge,
  BELIEF_CONFIG,
} from './belief-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EpisodeRow {
  id: string;
  summary: string;
  entities: string | null;
  embedding: Buffer | null;
  scope: string;
  project: string | null;
  project_path: string | null;
  created_at: number;
}

interface BeliefCandidate {
  statement: string;
  subject: string | null;
  predicate: string | null;
  context: string | null;
  timeframe: string | null;
  embedding: Buffer;
  episodeIds: string[];
  scope: string;
  project: string | null;
  projectPath: string | null;
}

interface Cluster {
  centroid: Float32Array;
  sum: Float32Array;
  episodes: EpisodeRow[];
}

type Classification = 'SUPPORTS' | 'CONTRADICTS' | 'PARTIAL' | 'IRRELEVANT';

// ---------------------------------------------------------------------------
// Safe JSON.parse wrappers
// ---------------------------------------------------------------------------

function safeParseArray(json: string): string[] {
  try { return JSON.parse(json); }
  catch { return []; }
}

function safeParseJson(json: string): any {
  try { return JSON.parse(json); }
  catch { return []; }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYNTHESIS_PROMPT = `You are extracting a generalized belief from a cluster of memory episodes.

Episodes:
{{EPISODES}}

Extract ONE belief statement that generalizes across these episodes. Also extract structured fields.

Respond in JSON:
{
  "statement": "A concise generalized belief (1 sentence, max 30 words)",
  "subject": "The entity this belief is about",
  "predicate": "The property or preference",
  "context": "When/where this applies (or 'general' if always)",
  "timeframe": "current | past | always"
}

Rules:
- Only generalize what ALL episodes support. Do not infer beyond the evidence.
- If episodes conflict, state the majority view and note the context.
- Keep the statement falsifiable — avoid vague claims.`;

const CLASSIFICATION_PROMPT = `Given an existing belief and a new candidate belief, classify the relationship.

Belief: {{BELIEF_STATEMENT}}
New candidate: {{CANDIDATE_STATEMENT}}

Classify as exactly one of:
- SUPPORTS: The candidate provides evidence for this belief
- CONTRADICTS: The candidate provides evidence against this belief
- PARTIAL: The candidate supports the belief in some contexts but not others
- IRRELEVANT: The candidate has no bearing on this belief

Respond in JSON:
{"classification": "SUPPORTS|CONTRADICTS|PARTIAL|IRRELEVANT", "reasoning": "brief explanation"}`;

const REVISION_PROMPT = `A belief needs revision because new evidence contradicts it.

Original belief: {{ORIGINAL}}
Contradicting evidence summaries:
{{EVIDENCE}}

Write a revised belief statement that accounts for the new evidence. Keep it concise (1 sentence, max 30 words).

Respond in JSON:
{"revised_statement": "...", "reason": "brief explanation of what changed"}`;

const SPLIT_PROMPT = `A belief appears to be true in some contexts but not others.

Belief: {{BELIEF}}
Supporting evidence: {{SUPPORTS}}
Contradicting/partial evidence: {{CONTRADICTS}}

Split into TWO context-dependent variants. Each should be true in its own context.

Respond in JSON:
{"variant_a": {"statement": "...", "context": "..."}, "variant_b": {"statement": "...", "context": "..."}}`;

const MERGE_PROMPT = `Two beliefs appear to be expressing the same idea.

Belief A: {{BELIEF_A}}
Belief B: {{BELIEF_B}}

Merge them into ONE concise belief statement (1 sentence, max 30 words).

Respond in JSON:
{"merged_statement": "...", "reason": "brief explanation"}`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runBeliefConsolidation(
  db: Database,
  openai: OpenAI,
  embedProvider: { embed(texts: string[]): Promise<(Float32Array | null)[]> },
): Promise<void> {
  const cycleStart = Date.now();
  const log = (msg: string) => console.error(`[belief-consolidator] ${msg}`);

  // -----------------------------------------------------------------------
  // 1. EXTRACT — get episodes since last checkpoint
  // -----------------------------------------------------------------------
  const checkpointRow = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'belief_consolidation_checkpoint'`
  ).get();
  const checkpoint = checkpointRow ? parseInt(checkpointRow.value, 10) : 0;

  const episodes = db.query<EpisodeRow, [number]>(`
    SELECT id, summary, entities, embedding, scope, project, project_path, created_at
    FROM episodes
    WHERE created_at > ?
      AND embedding IS NOT NULL
    ORDER BY created_at ASC
  `).all(checkpoint);

  if (episodes.length < BELIEF_CONFIG.EPISODE_THRESHOLD) {
    log(`Only ${episodes.length} new episodes (need ${BELIEF_CONFIG.EPISODE_THRESHOLD}) — skipping`);
    return;
  }

  log(`Processing ${episodes.length} episodes since checkpoint ${checkpoint}`);

  // -----------------------------------------------------------------------
  // 2. CLUSTER — greedy single-linkage by vector similarity
  // -----------------------------------------------------------------------
  const clusters = clusterEpisodes(episodes);
  const viableClusters = clusters.filter(c => c.episodes.length >= BELIEF_CONFIG.MIN_CLUSTER_SIZE);
  log(`Formed ${clusters.length} clusters, ${viableClusters.length} viable (>= ${BELIEF_CONFIG.MIN_CLUSTER_SIZE} episodes)`);

  if (viableClusters.length === 0) {
    // Update checkpoint even if no viable clusters — don't re-process these episodes
    updateCheckpoint(db, episodes);
    log('No viable clusters — checkpoint updated');
    return;
  }

  // Limit clusters per cycle
  const clustersToProcess = viableClusters.slice(0, BELIEF_CONFIG.MAX_CLUSTERS_PER_CYCLE);

  // -----------------------------------------------------------------------
  // 3. SYNTHESIZE + 4. MATCH — for each cluster
  // -----------------------------------------------------------------------
  const candidatesForRevision: { beliefId: string }[] = [];
  const partialAccumulator = new Map<string, number>(); // beliefId -> count of PARTIAL classifications this cycle
  const processedEpisodeIds = new Set<string>(); // Track which episodes were actually processed

  // Load active beliefs ONCE before the loop to avoid N+1 queries
  let cachedActiveBeliefs = loadActiveBeliefs(db);

  for (const cluster of clustersToProcess) {
    if (budgetExceeded(cycleStart)) {
      log('Budget exceeded — saving progress');
      break;
    }

    try {
      const candidate = await synthesizeCluster(cluster, openai, embedProvider, log);
      if (!candidate) continue;

      const mutated = await matchCandidate(
        db, openai, candidate, candidatesForRevision, partialAccumulator, cycleStart, log,
        cachedActiveBeliefs,
      );
      // Reload active beliefs after any DB mutation to stay fresh
      if (mutated) {
        cachedActiveBeliefs = loadActiveBeliefs(db);
      }
      // Mark these episodes as processed (only after successful synthesis+match)
      for (const id of candidate.episodeIds) processedEpisodeIds.add(id);
    } catch (err) {
      log(`Cluster synthesis/match error: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // 5. REVISION CHECK
  // -----------------------------------------------------------------------
  if (!budgetExceeded(cycleStart)) {
    for (const { beliefId } of candidatesForRevision) {
      if (budgetExceeded(cycleStart)) break;
      try {
        // Load peak_confidence from the belief row to use as previousConfidence
        const beliefRow = db.query<{ peak_confidence: number | null }, [string]>(
          `SELECT peak_confidence FROM beliefs WHERE id = ?`
        ).get(beliefId);
        // If peak_confidence is null, skip revision for this belief
        if (!beliefRow || beliefRow.peak_confidence == null) continue;
        await checkAndRevise(db, openai, embedProvider, beliefId, beliefRow.peak_confidence, log);
      } catch (err) {
        log(`Revision error for ${beliefId}: ${(err as Error).message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6. SPLIT CHECK
  // -----------------------------------------------------------------------
  if (!budgetExceeded(cycleStart)) {
    for (const [beliefId, partialCount] of partialAccumulator) {
      if (budgetExceeded(cycleStart)) break;
      try {
        await checkAndSplit(db, openai, embedProvider, beliefId, log);
      } catch (err) {
        log(`Split error for ${beliefId}: ${(err as Error).message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 7. MERGE CHECK
  // -----------------------------------------------------------------------
  if (!budgetExceeded(cycleStart)) {
    try {
      await checkAndMerge(db, openai, embedProvider, cycleStart, log);
    } catch (err) {
      log(`Merge check error: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // 8. DECAY / ARCHIVE
  // -----------------------------------------------------------------------
  if (!budgetExceeded(cycleStart)) {
    archiveDecayed(db, log);
  }

  // -----------------------------------------------------------------------
  // 9. UPDATE CHECKPOINT — only advance to the max created_at of episodes
  //    that were actually processed, so unprocessed episodes (due to budget
  //    break or failed clusters) are retried next cycle.
  // -----------------------------------------------------------------------
  const processedEpisodes = processedEpisodeIds.size > 0
    ? episodes.filter(ep => processedEpisodeIds.has(ep.id))
    : [];
  if (processedEpisodes.length > 0) {
    updateCheckpoint(db, processedEpisodes);
    log(`Checkpoint advanced to processed episodes (${processedEpisodes.length}/${episodes.length})`);
  } else {
    log('No episodes processed — checkpoint not advanced');
  }
  const elapsed = Date.now() - cycleStart;
  log(`Cycle complete in ${(elapsed / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

function clusterEpisodes(episodes: EpisodeRow[]): Cluster[] {
  const clusters: Cluster[] = [];

  for (const ep of episodes) {
    if (!ep.embedding) continue;

    const vec = unpackEmbedding(ep.embedding as Buffer);
    let bestCluster: Cluster | null = null;
    let bestSim = -1;

    for (const cluster of clusters) {
      const sim = cosineSimilarityFloat(vec, cluster.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestSim > BELIEF_CONFIG.CLUSTER_SIMILARITY_THRESHOLD) {
      bestCluster.episodes.push(ep);
      // Incremental centroid update: add to running sum, recompute centroid
      for (let i = 0; i < vec.length; i++) {
        bestCluster.sum[i] += vec[i];
      }
      updateCentroid(bestCluster);
    } else {
      const sum = new Float32Array(vec);
      clusters.push({
        centroid: new Float32Array(vec),
        sum,
        episodes: [ep],
      });
    }
  }

  return clusters;
}

/** Recompute centroid from running sum (O(dim) instead of O(n*dim)) */
function updateCentroid(cluster: Cluster): void {
  const dim = cluster.centroid.length;
  const n = cluster.episodes.length;
  for (let i = 0; i < dim; i++) {
    cluster.centroid[i] = cluster.sum[i] / n;
  }
}

/** Cosine similarity on raw Float32Arrays (avoids Buffer packing/unpacking overhead) */
function cosineSimilarityFloat(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

async function synthesizeCluster(
  cluster: Cluster,
  openai: OpenAI,
  embedProvider: { embed(texts: string[]): Promise<(Float32Array | null)[]> },
  log: (msg: string) => void,
): Promise<BeliefCandidate | null> {
  const episodeText = cluster.episodes
    .map((ep, i) => `${i + 1}. ${ep.summary}${ep.entities ? ` [${ep.entities}]` : ''}`)
    .join('\n');

  const prompt = SYNTHESIS_PROMPT.replace('{{EPISODES}}', episodeText);

  const response = await callLLM(openai, BELIEF_CONFIG.SYNTHESIS_MODEL, prompt);
  if (!response) return null;

  let parsed: { statement: string; subject?: string; predicate?: string; context?: string; timeframe?: string };
  try {
    parsed = JSON.parse(response);
  } catch {
    log('Failed to parse synthesis response');
    return null;
  }

  if (!parsed.statement) {
    log('Synthesis returned empty statement');
    return null;
  }

  // Embed the statement
  const embeddings = await embedProvider.embed([parsed.statement]);
  if (!embeddings || embeddings.length === 0 || !embeddings[0]) {
    log('Failed to embed belief statement');
    return null;
  }

  // Determine scope from cluster episodes (majority vote)
  const scopeCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  let projectPath: string | null = null;
  for (const ep of cluster.episodes) {
    scopeCounts.set(ep.scope, (scopeCounts.get(ep.scope) ?? 0) + 1);
    if (ep.project) {
      projectCounts.set(ep.project, (projectCounts.get(ep.project) ?? 0) + 1);
    }
    if (ep.project_path) projectPath = ep.project_path;
  }

  let scope = 'global';
  let project: string | null = null;
  if (scopeCounts.has('project') && (scopeCounts.get('project')! > (scopeCounts.get('global') ?? 0))) {
    scope = 'project';
    // Pick majority project
    let maxCount = 0;
    for (const [proj, count] of projectCounts) {
      if (count > maxCount) {
        maxCount = count;
        project = proj;
      }
    }
  }

  return {
    statement: parsed.statement,
    subject: parsed.subject ?? null,
    predicate: parsed.predicate ?? null,
    context: parsed.context ?? null,
    timeframe: parsed.timeframe ?? null,
    embedding: packEmbedding(embeddings[0]),
    episodeIds: cluster.episodes.map(ep => ep.id),
    scope,
    project,
    projectPath: projectPath,
  };
}

// ---------------------------------------------------------------------------
// Matching — compare candidate against existing beliefs
// ---------------------------------------------------------------------------

/** Load all active beliefs with embeddings from DB */
function loadActiveBeliefs(db: Database): Belief[] {
  return db.query<Belief, []>(`
    SELECT * FROM beliefs WHERE status = 'active' AND embedding IS NOT NULL
  `).all();
}

async function matchCandidate(
  db: Database,
  openai: OpenAI,
  candidate: BeliefCandidate,
  candidatesForRevision: { beliefId: string }[],
  partialAccumulator: Map<string, number>,
  cycleStart: number,
  log: (msg: string) => void,
  allActiveBeliefs: Belief[],
): Promise<boolean> {
  const now = Date.now();
  let mutated = false;

  // Scope-aware filtering to prevent cross-project reinforcement
  let activeBeliefs: Belief[];
  if (candidate.scope === 'project' && candidate.project) {
    activeBeliefs = allActiveBeliefs.filter(
      b => b.scope === 'global' || b.project === candidate.project,
    );
  } else {
    activeBeliefs = allActiveBeliefs;
  }

  if (activeBeliefs.length === 0) {
    // No existing beliefs — this is a novel belief
    createNewBelief(db, candidate, now, log);
    return true;
  }

  // Compute similarities
  const similarities: { belief: Belief; sim: number }[] = [];
  for (const belief of activeBeliefs) {
    const sim = cosineSimilarity(candidate.embedding, belief.embedding!);
    similarities.push({ belief, sim });
  }

  // Sort by similarity descending
  similarities.sort((a, b) => b.sim - a.sim);

  const top = similarities[0];

  // Case 1: cosine > REINFORCE_THRESHOLD → REINFORCE directly
  if (top.sim > BELIEF_CONFIG.REINFORCE_THRESHOLD) {
    reinforceBelief(db, top.belief, candidate.episodeIds, now, log);
    return true;
  }

  // Case 2: cosine > RELATED_THRESHOLD → run classification
  if (top.sim > BELIEF_CONFIG.RELATED_THRESHOLD) {
    const beliefsToClassify = similarities
      .filter(s => s.sim > BELIEF_CONFIG.RELATED_THRESHOLD)
      .slice(0, BELIEF_CONFIG.MAX_CLASSIFICATIONS_PER_CLUSTER);

    let matched = false;
    for (const { belief, sim } of beliefsToClassify) {
      if (budgetExceeded(cycleStart)) break;

      const classification = await classifyRelationship(openai, belief.statement, candidate.statement, log);
      if (!classification) continue;

      switch (classification) {
        case 'SUPPORTS':
          reinforceBelief(db, belief, candidate.episodeIds, now, log);
          matched = true;
          mutated = true;
          break;

        case 'CONTRADICTS': {
          contradictBelief(db, belief, candidate.episodeIds, now, log);
          candidatesForRevision.push({ beliefId: belief.id });
          matched = true;
          mutated = true;
          break;
        }

        case 'PARTIAL': {
          // Log to contradicting_episodes with PARTIAL flag, and weakly update both alpha and beta
          const contradicting: string[] = safeParseArray(belief.contradicting_episodes);
          const newContradicting = [...contradicting, ...candidate.episodeIds.map(id => `PARTIAL:${id}`)];
          const partialIncrement = candidate.episodeIds.length * 0.5;
          db.query(`
            UPDATE beliefs SET
              confidence_alpha = confidence_alpha + ?,
              confidence_beta = confidence_beta + ?,
              evidence_count = evidence_count + ?,
              contradicting_episodes = ?,
              updated_at = ?
            WHERE id = ?
          `).run(partialIncrement, partialIncrement, candidate.episodeIds.length, JSON.stringify(newContradicting), now, belief.id);

          partialAccumulator.set(belief.id, (partialAccumulator.get(belief.id) ?? 0) + 1);
          matched = true;
          mutated = true;
          break;
        }

        case 'IRRELEVANT':
          // Skip — try next similar belief
          break;
      }

      if (matched) break;
    }

    // If no classification matched, treat as novel
    if (!matched) {
      createNewBelief(db, candidate, now, log);
      mutated = true;
    }
    return mutated;
  }

  // Case 3: cosine < RELATED_THRESHOLD → NOVEL
  createNewBelief(db, candidate, now, log);
  return true;
}

// ---------------------------------------------------------------------------
// Belief CRUD operations
// ---------------------------------------------------------------------------

function createNewBelief(
  db: Database,
  candidate: BeliefCandidate,
  now: number,
  log: (msg: string) => void,
): void {
  const id = generateBeliefId();
  const initialAlpha = 1 + candidate.episodeIds.length; // prior of 1 + N supporting observations
  const initialPeakConfidence = beliefConfidence(initialAlpha, 1);
  db.query(`
    INSERT INTO beliefs (
      id, statement, subject, predicate, context, timeframe,
      confidence_alpha, confidence_beta,
      scope, project, project_path,
      supporting_episodes, contradicting_episodes,
      revision_history, parent_belief_id, child_belief_ids,
      embedding, status, evidence_count, stability,
      created_at, updated_at, last_reinforced_at, last_accessed_at, access_count,
      peak_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, '[]', '[]', NULL, '[]', ?, 'active', ?, ${BELIEF_CONFIG.DEFAULT_STABILITY}, ?, ?, ?, NULL, 0, ?)
  `).run(
    id,
    candidate.statement,
    candidate.subject,
    candidate.predicate,
    candidate.context,
    candidate.timeframe,
    initialAlpha,
    candidate.scope,
    candidate.project,
    candidate.projectPath,
    JSON.stringify(candidate.episodeIds),
    candidate.embedding,
    candidate.episodeIds.length,
    now,
    now,
    now,
    initialPeakConfidence,
  );

  log(`Created new belief ${id} (alpha=${initialAlpha}): "${candidate.statement.slice(0, 60)}..."`);
}

function reinforceBelief(
  db: Database,
  belief: Belief,
  episodeIds: string[],
  now: number,
  log: (msg: string) => void,
): void {
  const supporting: string[] = safeParseArray(belief.supporting_episodes);
  const newSupporting = [...supporting, ...episodeIds.filter(id => !supporting.includes(id))];
  const increment = episodeIds.length;

  const newAlpha = belief.confidence_alpha + increment;
  const newConfidence = beliefConfidence(newAlpha, belief.confidence_beta);
  const currentPeak = belief.peak_confidence ?? 0;
  const newPeak = newConfidence > currentPeak ? newConfidence : currentPeak;

  db.query(`
    UPDATE beliefs SET
      confidence_alpha = confidence_alpha + ?,
      supporting_episodes = ?,
      evidence_count = evidence_count + ?,
      last_reinforced_at = ?,
      updated_at = ?,
      peak_confidence = ?
    WHERE id = ?
  `).run(increment, JSON.stringify(newSupporting), increment, now, now, newPeak, belief.id);

  log(`Reinforced belief ${belief.id} (alpha now ${newAlpha})`);
}

function contradictBelief(
  db: Database,
  belief: Belief,
  episodeIds: string[],
  now: number,
  log: (msg: string) => void,
): void {
  const contradicting: string[] = safeParseArray(belief.contradicting_episodes);
  const newContradicting = [...contradicting, ...episodeIds.filter(id => !contradicting.includes(id))];
  const increment = episodeIds.length;

  db.query(`
    UPDATE beliefs SET
      confidence_beta = confidence_beta + ?,
      contradicting_episodes = ?,
      evidence_count = evidence_count + ?,
      updated_at = ?
    WHERE id = ?
  `).run(increment, JSON.stringify(newContradicting), increment, now, belief.id);

  log(`Contradicted belief ${belief.id} (beta now ${belief.confidence_beta + increment})`);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

async function classifyRelationship(
  openai: OpenAI,
  beliefStatement: string,
  candidateStatement: string,
  log: (msg: string) => void,
): Promise<Classification | null> {
  const prompt = CLASSIFICATION_PROMPT
    .replace('{{BELIEF_STATEMENT}}', beliefStatement)
    .replace('{{CANDIDATE_STATEMENT}}', candidateStatement);

  const response = await callLLM(openai, BELIEF_CONFIG.CLASSIFICATION_MODEL, prompt);
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    const classification = parsed.classification as string;
    if (['SUPPORTS', 'CONTRADICTS', 'PARTIAL', 'IRRELEVANT'].includes(classification)) {
      return classification as Classification;
    }
    log(`Invalid classification: ${classification}`);
    return null;
  } catch {
    log('Failed to parse classification response');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5. Revision
// ---------------------------------------------------------------------------

async function checkAndRevise(
  db: Database,
  openai: OpenAI,
  embedProvider: { embed(texts: string[]): Promise<(Float32Array | null)[]> },
  beliefId: string,
  previousConfidence: number,
  log: (msg: string) => void,
): Promise<void> {
  const belief = db.query<Belief, [string]>(`SELECT * FROM beliefs WHERE id = ?`).get(beliefId);
  if (!belief || belief.status !== 'active') return;

  const contradicting: string[] = safeParseArray(belief.contradicting_episodes);
  // Filter out PARTIAL-prefixed entries for revision check
  const pureContradictions = contradicting.filter(id => !id.startsWith('PARTIAL:'));

  if (!shouldRevise(
    belief.confidence_alpha,
    belief.confidence_beta,
    pureContradictions.length,
    belief.evidence_count,
    previousConfidence,
  )) return;

  // Fetch contradicting episode summaries
  const contradictingIds = pureContradictions.slice(0, 10);
  const placeholders = contradictingIds.map(() => '?').join(',');
  const contradictingEps = contradictingIds.length > 0
    ? db.query<{ summary: string }, string[]>(
        `SELECT summary FROM episodes WHERE id IN (${placeholders})`
      ).all(...contradictingIds)
    : [];

  const evidenceText = contradictingEps.map((ep, i) => `${i + 1}. ${ep.summary}`).join('\n');
  const prompt = REVISION_PROMPT
    .replace('{{ORIGINAL}}', belief.statement)
    .replace('{{EVIDENCE}}', evidenceText);

  const response = await callLLM(openai, BELIEF_CONFIG.SYNTHESIS_MODEL, prompt);
  if (!response) return;

  let parsed: { revised_statement: string; reason: string };
  try {
    parsed = JSON.parse(response);
  } catch {
    log(`Failed to parse revision response for ${beliefId}`);
    return;
  }

  if (!parsed.revised_statement) return;

  const now = Date.now();

  // Embed the revised statement
  const embeddings = await embedProvider.embed([parsed.revised_statement]);
  if (!embeddings || embeddings.length === 0 || !embeddings[0]) return;

  // Create new belief with revised statement
  const newId = generateBeliefId();
  const revisionHistory: Array<{ timestamp: number; old_statement: string; old_confidence: number; reason: string }> = safeParseJson(belief.revision_history);
  revisionHistory.push({
    timestamp: now,
    old_statement: belief.statement,
    old_confidence: beliefConfidence(belief.confidence_alpha, belief.confidence_beta),
    reason: parsed.reason,
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    // Create new revised belief — inherit alpha/beta from old belief to preserve confidence history
    const revisedPeakConfidence = beliefConfidence(belief.confidence_alpha, belief.confidence_beta);
    db.query(`
      INSERT INTO beliefs (
        id, statement, subject, predicate, context, timeframe,
        confidence_alpha, confidence_beta,
        scope, project, project_path,
        supporting_episodes, contradicting_episodes,
        revision_history, parent_belief_id, child_belief_ids,
        embedding, status, evidence_count, stability,
        created_at, updated_at, last_reinforced_at, last_accessed_at, access_count,
        peak_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, '[]', ?, 'active', ?, ${BELIEF_CONFIG.DEFAULT_STABILITY}, ?, ?, NULL, NULL, 0, ?)
    `).run(
      newId,
      parsed.revised_statement,
      belief.subject,
      belief.predicate,
      belief.context,
      belief.timeframe,
      belief.confidence_alpha,
      belief.confidence_beta,
      belief.scope,
      belief.project,
      belief.project_path,
      belief.supporting_episodes,
      JSON.stringify(revisionHistory),
      belief.id,
      packEmbedding(embeddings[0]),
      belief.evidence_count,
      now,
      now,
      revisedPeakConfidence,
    );

    // Update old belief: status → revised, link child
    const childIds: string[] = safeParseArray(belief.child_belief_ids);
    childIds.push(newId);
    db.query(`
      UPDATE beliefs SET status = 'revised', child_belief_ids = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(childIds), now, belief.id);

    db.exec('COMMIT');
    log(`Revised belief ${belief.id} → ${newId}: "${parsed.revised_statement.slice(0, 60)}..."`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 6. Split
// ---------------------------------------------------------------------------

async function checkAndSplit(
  db: Database,
  openai: OpenAI,
  embedProvider: { embed(texts: string[]): Promise<(Float32Array | null)[]> },
  beliefId: string,
  log: (msg: string) => void,
): Promise<void> {
  const belief = db.query<Belief, [string]>(`SELECT * FROM beliefs WHERE id = ?`).get(beliefId);
  if (!belief || belief.status !== 'active') return;

  const supporting: string[] = safeParseArray(belief.supporting_episodes);
  const contradicting: string[] = safeParseArray(belief.contradicting_episodes);
  // Count PARTIAL episodes only from the stored contradicting_episodes list.
  // partialCountThisCycle tracks classifications that were ALREADY written as
  // PARTIAL:-prefixed entries in contradicting_episodes, so adding both would
  // double-count. The DB is the single source of truth.
  const totalPartial = contradicting.filter(id => id.startsWith('PARTIAL:')).length;
  const pureContradictions = contradicting.filter(id => !id.startsWith('PARTIAL:')).length;

  if (!shouldSplit(supporting.length, pureContradictions, totalPartial, belief.evidence_count)) return;

  // Fetch episode summaries for context
  const supportIds = supporting.slice(0, 5);
  const contradictIds = contradicting
    .map(id => id.replace('PARTIAL:', ''))
    .slice(0, 5);

  const supportPlaceholders = supportIds.map(() => '?').join(',');
  const contradictPlaceholders = contradictIds.map(() => '?').join(',');

  const supportEps = supportIds.length > 0
    ? db.query<{ summary: string }, string[]>(
        `SELECT summary FROM episodes WHERE id IN (${supportPlaceholders})`
      ).all(...supportIds)
    : [];

  const contradictEps = contradictIds.length > 0
    ? db.query<{ summary: string }, string[]>(
        `SELECT summary FROM episodes WHERE id IN (${contradictPlaceholders})`
      ).all(...contradictIds)
    : [];

  const supportsText = supportEps.map((ep, i) => `${i + 1}. ${ep.summary}`).join('\n');
  const contradictsText = contradictEps.map((ep, i) => `${i + 1}. ${ep.summary}`).join('\n');

  const prompt = SPLIT_PROMPT
    .replace('{{BELIEF}}', belief.statement)
    .replace('{{SUPPORTS}}', supportsText)
    .replace('{{CONTRADICTS}}', contradictsText);

  const response = await callLLM(openai, BELIEF_CONFIG.SYNTHESIS_MODEL, prompt);
  if (!response) return;

  let parsed: {
    variant_a: { statement: string; context: string };
    variant_b: { statement: string; context: string };
  };
  try {
    parsed = JSON.parse(response);
  } catch {
    log(`Failed to parse split response for ${beliefId}`);
    return;
  }

  if (!parsed.variant_a?.statement || !parsed.variant_b?.statement) return;

  const now = Date.now();

  // Embed both variants
  const embeddings = await embedProvider.embed([parsed.variant_a.statement, parsed.variant_b.statement]);
  if (!embeddings || embeddings.length < 2 || !embeddings[0] || !embeddings[1]) return;

  const idA = generateBeliefId();
  const idB = generateBeliefId();

  db.exec('BEGIN IMMEDIATE');
  try {
    // Split children inherit half the parent's evidence
    const childAlpha = Math.max(1, Math.round(belief.confidence_alpha / 2));
    const childBeta = Math.max(1, Math.round(belief.confidence_beta / 2));

    // Create variant A — inherits supporting_episodes and evidence_count from original
    db.query(`
      INSERT INTO beliefs (
        id, statement, subject, predicate, context, timeframe,
        confidence_alpha, confidence_beta,
        scope, project, project_path,
        supporting_episodes, contradicting_episodes,
        revision_history, parent_belief_id, child_belief_ids,
        embedding, status, evidence_count, stability,
        created_at, updated_at, last_reinforced_at, last_accessed_at, access_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, '[]', ?, 'active', ?, ${BELIEF_CONFIG.DEFAULT_STABILITY}, ?, ?, NULL, NULL, 0)
    `).run(
      idA,
      parsed.variant_a.statement,
      belief.subject,
      belief.predicate,
      parsed.variant_a.context,
      belief.timeframe,
      childAlpha, childBeta,
      belief.scope, belief.project, belief.project_path,
      belief.supporting_episodes,
      belief.id,
      packEmbedding(embeddings[0]),
      belief.evidence_count,
      now, now,
    );

    // Create variant B — inherits supporting_episodes and evidence_count from original
    db.query(`
      INSERT INTO beliefs (
        id, statement, subject, predicate, context, timeframe,
        confidence_alpha, confidence_beta,
        scope, project, project_path,
        supporting_episodes, contradicting_episodes,
        revision_history, parent_belief_id, child_belief_ids,
        embedding, status, evidence_count, stability,
        created_at, updated_at, last_reinforced_at, last_accessed_at, access_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, '[]', ?, 'active', ?, ${BELIEF_CONFIG.DEFAULT_STABILITY}, ?, ?, NULL, NULL, 0)
    `).run(
      idB,
      parsed.variant_b.statement,
      belief.subject,
      belief.predicate,
      parsed.variant_b.context,
      belief.timeframe,
      childAlpha, childBeta,
      belief.scope, belief.project, belief.project_path,
      belief.supporting_episodes,
      belief.id,
      packEmbedding(embeddings[1]),
      belief.evidence_count,
      now, now,
    );

    // Update original: status → split, link children
    const childIds: string[] = safeParseArray(belief.child_belief_ids);
    childIds.push(idA, idB);
    db.query(`
      UPDATE beliefs SET status = 'split', child_belief_ids = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(childIds), now, belief.id);

    db.exec('COMMIT');
    log(`Split belief ${belief.id} → ${idA} + ${idB}`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 7. Merge
// ---------------------------------------------------------------------------

async function checkAndMerge(
  db: Database,
  openai: OpenAI,
  embedProvider: { embed(texts: string[]): Promise<(Float32Array | null)[]> },
  cycleStart: number,
  log: (msg: string) => void,
): Promise<void> {
  const now = Date.now();

  const activeBeliefs = db.query<Belief, []>(`
    SELECT * FROM beliefs WHERE status = 'active' AND embedding IS NOT NULL
  `).all();

  if (activeBeliefs.length < 2) return;

  // Check all pairs (O(n^2) but beliefs table is expected to be small)
  for (let i = 0; i < activeBeliefs.length; i++) {
    if (budgetExceeded(cycleStart)) break;

    for (let j = i + 1; j < activeBeliefs.length; j++) {
      const a = activeBeliefs[i];
      const b = activeBeliefs[j];

      const sim = cosineSimilarity(a.embedding!, b.embedding!);
      const sameScope = a.scope === b.scope && a.project === b.project;
      const confA = beliefConfidence(a.confidence_alpha, a.confidence_beta);
      const confB = beliefConfidence(b.confidence_alpha, b.confidence_beta);

      if (!shouldMerge(sim, sameScope, confA, confB, a.updated_at, b.updated_at, now)) continue;

      // Call LLM to merge
      const prompt = MERGE_PROMPT
        .replace('{{BELIEF_A}}', a.statement)
        .replace('{{BELIEF_B}}', b.statement);

      const response = await callLLM(openai, BELIEF_CONFIG.SYNTHESIS_MODEL, prompt);
      if (!response) continue;

      let parsed: { merged_statement: string; reason: string };
      try {
        parsed = JSON.parse(response);
      } catch {
        continue;
      }

      if (!parsed.merged_statement) continue;

      // Embed merged statement
      const embeddings = await embedProvider.embed([parsed.merged_statement]);
      if (!embeddings || embeddings.length === 0 || !embeddings[0]) continue;

      const newId = generateBeliefId();

      // Merge supporting/contradicting episodes
      const supportA: string[] = safeParseArray(a.supporting_episodes);
      const supportB: string[] = safeParseArray(b.supporting_episodes);
      const mergedSupporting = [...new Set([...supportA, ...supportB])];

      const contradictA: string[] = safeParseArray(a.contradicting_episodes);
      const contradictB: string[] = safeParseArray(b.contradicting_episodes);
      const mergedContradicting = [...new Set([...contradictA, ...contradictB])];

      // Merge confidence: combine alpha and beta counts
      const mergedAlpha = Math.max(1, a.confidence_alpha + b.confidence_alpha - 1); // subtract one prior
      const mergedBeta = Math.max(1, a.confidence_beta + b.confidence_beta - 1);
      const mergedPeakConfidence = beliefConfidence(mergedAlpha, mergedBeta);

      db.exec('BEGIN IMMEDIATE');
      try {
        db.query(`
          INSERT INTO beliefs (
            id, statement, subject, predicate, context, timeframe,
            confidence_alpha, confidence_beta,
            scope, project, project_path,
            supporting_episodes, contradicting_episodes,
            revision_history, parent_belief_id, child_belief_ids,
            embedding, status, evidence_count, stability,
            created_at, updated_at, last_reinforced_at, last_accessed_at, access_count,
            peak_confidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, '[]', ?, 'active', ?, ${BELIEF_CONFIG.DEFAULT_STABILITY}, ?, ?, ?, NULL, 0, ?)
        `).run(
          newId,
          parsed.merged_statement,
          a.subject ?? b.subject,
          a.predicate ?? b.predicate,
          a.context ?? b.context,
          a.timeframe ?? b.timeframe,
          mergedAlpha,
          mergedBeta,
          a.scope,
          a.project,
          a.project_path ?? b.project_path,
          JSON.stringify(mergedSupporting),
          JSON.stringify(mergedContradicting),
          packEmbedding(embeddings[0]),
          a.evidence_count + b.evidence_count,
          now,
          now,
          Math.max(a.last_reinforced_at ?? 0, b.last_reinforced_at ?? 0) || null,
          mergedPeakConfidence,
        );

        // Update both originals: status → merged, link child
        for (const original of [a, b]) {
          const childIds: string[] = safeParseArray(original.child_belief_ids);
          childIds.push(newId);
          db.query(`
            UPDATE beliefs SET status = 'merged', child_belief_ids = ?, updated_at = ? WHERE id = ?
          `).run(JSON.stringify(childIds), now, original.id);
        }

        db.exec('COMMIT');
        log(`Merged beliefs ${a.id} + ${b.id} → ${newId}: "${parsed.merged_statement.slice(0, 60)}..."`);

        // After merge, return — the activeBeliefs array is now stale
        return;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Decay / Archive
// ---------------------------------------------------------------------------

function archiveDecayed(db: Database, log: (msg: string) => void): void {
  const now = Date.now();
  const activeBeliefs = db.query<Belief, []>(`
    SELECT * FROM beliefs WHERE status = 'active'
  `).all();

  let archived = 0;
  for (const belief of activeBeliefs) {
    if (shouldArchive(
      belief.confidence_alpha,
      belief.confidence_beta,
      belief.last_reinforced_at,
      belief.evidence_count,
      now,
      belief.created_at,
    )) {
      db.query(`UPDATE beliefs SET status = 'archived', updated_at = ? WHERE id = ?`)
        .run(now, belief.id);
      archived++;
    }
  }

  if (archived > 0) {
    log(`Archived ${archived} decayed beliefs`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function budgetExceeded(cycleStart: number): boolean {
  return Date.now() - cycleStart > BELIEF_CONFIG.MAX_CYCLE_BUDGET_MS;
}

function updateCheckpoint(db: Database, episodes: EpisodeRow[]): void {
  if (episodes.length === 0) return;
  const maxCreatedAt = Math.max(...episodes.map(ep => ep.created_at));
  db.query(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('belief_consolidation_checkpoint', ?)`)
    .run(String(maxCreatedAt));
}

async function callLLM(
  openai: OpenAI,
  model: string,
  prompt: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BELIEF_CONFIG.PER_CALL_TIMEOUT_MS);
  try {
    const response = await openai.chat.completions.create(
      {
        model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      { signal: controller.signal },
    );

    return response.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.error(`[belief-consolidator] LLM call failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
