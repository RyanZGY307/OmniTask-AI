// ================================================================
// Compression Worker — background executor for ContextCompressionJob.
// Reuses the shared workerPool concurrency model: this is the module
// the pool claims jobs from. No unbounded Promise.all; the pool's own
// caps bound parallelism.
// ================================================================

import { executeCompressionJob } from './compression';

// Entry point used by the workerPool executor registration.
export async function runCompressionJob(jobId: string): Promise<void> {
  await executeCompressionJob(jobId);
}
