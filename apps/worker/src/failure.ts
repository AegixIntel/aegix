import type { Job } from "bullmq";

/** BullMQ emits `failed` after every unsuccessful attempt. A DLQ record is
 * terminal evidence, so it must only be published after all attempts are
 * exhausted (jobs without an explicit attempts option get one attempt). */
export function isFinalJobFailure(job: Pick<Job, "attemptsMade" | "opts"> | undefined): boolean {
  if (!job) return true;
  const allowedAttempts = Math.max(1, Number(job.opts.attempts ?? 1));
  return job.attemptsMade >= allowedAttempts;
}
