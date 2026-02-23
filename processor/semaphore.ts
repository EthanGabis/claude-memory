// ---------------------------------------------------------------------------
// Extraction semaphore — limits concurrent OpenAI API calls to avoid
// 429 rate limits and memory pressure during startup burst
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_EXTRACTIONS = 3;

let activeExtractions = 0;
const extractionWaiters: (() => void)[] = [];

export async function acquireExtractionSlot(): Promise<void> {
  if (activeExtractions < MAX_CONCURRENT_EXTRACTIONS) {
    activeExtractions++;
    return;
  }
  // Wait for a slot to open
  await new Promise<void>(resolve => extractionWaiters.push(resolve));
  activeExtractions++;
}

export function releaseExtractionSlot(): void {
  activeExtractions--;
  const next = extractionWaiters.shift();
  if (next) next();
}
