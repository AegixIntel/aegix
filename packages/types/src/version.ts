/**
 * Identity of the analysis pipeline that produced a result.
 *
 * This is a single shared constant on purpose. The worker stamps it onto
 * `analysis_jobs.engine_version`, and the API uses it to namespace the
 * analysis dedup lock — when the two drifted apart, a deploy could reuse a
 * lock from a pipeline that no longer exists.
 *
 * Bump it whenever the pipeline's output changes in a way that makes two
 * analyses non-comparable. `computeComparability` in `@aegix/diff` reads the
 * stamped value to suppress score-based monitor alerts across such a change,
 * so an un-bumped version reports a scoring change as a wallet change.
 *
 * v1.1.0 — added the transaction pattern, public attribution and linkability
 * engines, which changed the exposure score's inputs.
 */
export const ANALYSIS_PIPELINE_VERSION = "aegix-pipeline-v1.1.0";
