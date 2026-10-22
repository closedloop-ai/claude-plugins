import { z } from "zod";

/**
 * Claude Code's stream-json `rate_limit_event`: the only usage signal a `claude --print` worker exposes. There is
 * no read-only usage query to call before a turn, so the launcher watches each turn's events instead.
 */
const rateLimitEventSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    status: z.string().min(1).max(64),
    rateLimitType: z.string().max(64).optional(),
    resetsAt: z.number().finite().optional(),
    isUsingOverage: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

export type ClaudeRateLimit = { status: string; rateLimitType?: string; resetsAt?: string; isUsingOverage?: boolean };

/** The status Claude reports once the plan's limit is used up. */
export const RATE_LIMIT_REJECTED = "rejected";

/** The compact rate-limit state from one stream event, or undefined when the event is not a rate-limit event. */
export function rateLimitFromEvent(event: unknown): ClaudeRateLimit | undefined {
  const parsed = rateLimitEventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const info = parsed.data.rate_limit_info;
  return {
    status: info.status,
    ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
    ...(info.resetsAt !== undefined && info.resetsAt > 0 ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
    ...(info.isUsingOverage !== undefined ? { isUsingOverage: info.isUsingOverage } : {}),
  };
}

/** True when the turn must stop: the limit is reached, or paid extra usage started and the person did not allow it. */
export function mustStopForUsage(rateLimit: ClaudeRateLimit | undefined, allowCredits: boolean): boolean {
  if (!rateLimit || allowCredits) return false;
  return rateLimit.status === RATE_LIMIT_REJECTED || rateLimit.isUsingOverage === true;
}
