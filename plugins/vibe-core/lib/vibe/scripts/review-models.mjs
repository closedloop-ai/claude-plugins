/**
 * The Fable model ids whose trace-proven review clears a Claude cloud import's independent-review gate
 * (cloud-worker.mjs, ISS-14039). The Claude launcher runs a role on any model it is given (ISS-14109).
 * A new Fable version is one entry here.
 */
export const FABLE_REVIEW_MODELS = Object.freeze(["claude-fable-5-2"]);
