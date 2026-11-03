/**
 * Model pricing for code-review cost attribution.
 *
 * Costs are computed from the raw token counts logged in Claude Code session
 * transcripts (`message.usage`) multiplied by public Anthropic list prices.
 * The numbers are ESTIMATES: they do not account for the 1M-context (>200K
 * input) long-context premium, nor any subscription/committed-use discount.
 * What they buy is a consistent, reproducible yardstick for measuring the
 * RELATIVE cost of a review and the impact of cost-reduction changes over
 * time. The same yardstick applied before and after a change makes the delta
 * meaningful even if the absolute dollar figure is approximate.
 *
 * Prices are USD per MILLION tokens. Cache-write tiers follow Anthropic's
 * multipliers over base input: 5-minute TTL = 1.25x, 1-hour TTL = 2x. Cache
 * read = 0.1x.
 */

export type ModelFamily = "opus" | "sonnet" | "haiku";

export type TokenKind = "input" | "cacheWrite5m" | "cacheWrite1h" | "cacheRead" | "output";

export interface TokenCounts {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export type Pricing = Record<ModelFamily, Record<TokenKind, number>>;

/** USD per million tokens. */
export const PRICING: Pricing = {
  opus: { input: 15.0, cacheWrite5m: 18.75, cacheWrite1h: 30.0, cacheRead: 1.5, output: 75.0 },
  sonnet: { input: 3.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.3, output: 15.0 },
  haiku: { input: 1.0, cacheWrite5m: 1.25, cacheWrite1h: 2.0, cacheRead: 0.1, output: 5.0 },
};

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
}

/**
 * Map a raw model id to its pricing family.
 *
 * Returns null for ids we cannot price (so the caller can surface unpriced
 * tokens rather than silently charge them at the wrong tier). `fable` is
 * priced at the opus tier — it is the rare top-tier model and appears only
 * incidentally in review transcripts.
 */
export function modelFamily(model: string | undefined | null): ModelFamily | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "opus";
  return null;
}

/** Cost in USD of a token bundle for a single model family. */
export function costOf(family: ModelFamily, tokens: TokenCounts): number {
  const p = PRICING[family];
  return (
    (tokens.input * p.input +
      tokens.cacheWrite5m * p.cacheWrite5m +
      tokens.cacheWrite1h * p.cacheWrite1h +
      tokens.cacheRead * p.cacheRead +
      tokens.output * p.output) /
    1_000_000
  );
}

/** Add `src` into `dst` in place (per-token-kind accumulation). */
export function addInto(dst: TokenCounts, src: TokenCounts): void {
  dst.input += src.input;
  dst.cacheWrite5m += src.cacheWrite5m;
  dst.cacheWrite1h += src.cacheWrite1h;
  dst.cacheRead += src.cacheRead;
  dst.output += src.output;
}
