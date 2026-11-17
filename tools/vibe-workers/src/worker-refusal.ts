/**
 * A launcher refusal whose external code and recovery summary are part of the worker contract.
 * Known validation and state decisions use this type so they cannot fall through to a generic failure.
 */
export class WorkerRefusal extends Error {
  constructor(readonly code: string, readonly summary: string, message = summary) {
    super(message);
    this.name = "WorkerRefusal";
  }
}
