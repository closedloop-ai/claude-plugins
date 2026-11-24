import path from "node:path";

export const FrozenOutcome = Object.freeze({
  Identical: "identical", UnstableOnBase: "unstable-on-base", SameFailure: "same-failure", Blocking: "blocking",
});

const MAX_FRESH_PAIRS = 20;
const MIN_REPEATS = 2;
const SHA = /^[a-f0-9]{40}$/;

/** One frozen play identity shared by historical and post-drain comparisons. */
export function playOutcome(render) {
  return JSON.stringify([render.verdict, render.reason, render.failure?.type ?? null, render.failure?.message ?? null]);
}

function fingerprint(render) {
  return render?.pixels && JSON.stringify([playOutcome(render), render.pixels]);
}

function confirmedIdentity(controls) {
  if (controls.length !== 2 || controls.some(({ comparison }) => comparison?.outcome !== FrozenOutcome.Identical)) return false;
  const renders = controls.flatMap(({ comparison }) => [comparison.renders?.base, comparison.renders?.head]);
  const identity = renders[0]?.pixels;
  return typeof identity === "string" && identity.length > 0
    && renders.every((render) => render?.verdict === "PASS" && render.pixels === identity);
}

function failureSignatures(renders) {
  return new Map(renders.filter((render) => render?.verdict === "FAIL").map((render) => [
    playOutcome(render),
    [render.reason, render.failure?.message].filter(Boolean).join(": ").replace(/\s+/g, " ").trim(),
  ]));
}

function originalRenders(original, side) {
  return Object.entries(original.renders ?? {}).filter(([name]) => name.startsWith(side)).map(([, render]) => render);
}

/**
 * A failed head needs an always-failing repeated base that covers every head
 * signature. A passing base repetition or a novel head signature blocks.
 * Known varying failures remain visible as unstable-on-base.
 */
export function repeatedFailureState(base, head) {
  if (base.length < MIN_REPEATS) return {};
  const headErrors = failureSignatures(head);
  const baseErrors = failureSignatures(base);
  if (headErrors.size > 0 && base.some((render) => render.verdict === "PASS")) return { basePassed: true };
  if ([...headErrors.keys()].some((signature) => !baseErrors.has(signature))) return { novelHead: true };
  const unstable = baseErrors.size > 1 && base.every((render) => render.verdict === "FAIL");
  return { unstable };
}

/** The verdict reason and failure text on one line, so each story stays one line of output. */
export function describePlay(render) {
  return `${render.reason}${render.failure?.message ? `: ${render.failure.message.replace(/\s+/g, " ").trim()}` : ""}`;
}

/** Explain a head play outcome not represented in the observed base repetitions. */
export function playChange(bases, head, renders) {
  const [base] = bases;
  if (new Set(bases.map(playOutcome)).size > 1) {
    return `the play's outcome differs between ${renders} and the branch matches none of them: branch ${head.verdict} (${describePlay(head)})`;
  }
  if (base.verdict !== head.verdict) {
    return `play ${base.verdict} on the base, ${head.verdict} on the branch${head.verdict === "FAIL" ? ` (${describePlay(head)})` : ""}`;
  }
  return `the failure changed: base ${describePlay(base)}, branch ${describePlay(head)}`;
}

function combinedRenders(original, controls, side) {
  return [...originalRenders(original, side), ...controls.map(({ comparison }) => comparison?.renders?.[side]).filter(Boolean)];
}

function repeatedBaseOutcome(controls, original, originalFailure) {
  const base = controls.map(({ comparison }) => comparison?.renders?.base);
  const head = controls.map(({ comparison }) => comparison?.renders?.head);
  if ([...base, ...head].some((render) => !fingerprint(render) || !["PASS", "FAIL"].includes(render.verdict)
    || render.verdict === "FAIL" && (!render.failure?.type || !render.failure?.message))) return { contradictory: true };
  const proof = repeatedFailureState(combinedRenders(original, controls, "base"), combinedRenders(original, controls, "head"));
  if (proof.basePassed) return { contradictory: true };
  if (proof.novelHead) return {};
  if (proof.unstable) return { outcome: FrozenOutcome.UnstableOnBase };
  const exact = [base, head].every((renders) => renders.filter((render) => fingerprint(render) === originalFailure).length >= MIN_REPEATS);
  return exact ? { outcome: FrozenOutcome.SameFailure } : {};
}

/** Render distinct errors per side beneath their own story heading. */
export function repeatedFailureLines(story) {
  const { parallel = story, controls = [] } = story.parallelConfirmation ?? {};
  const base = combinedRenders(parallel, controls, "base");
  const head = combinedRenders(parallel, controls, "head");
  const proof = repeatedFailureState(base, head);
  if (story.outcome !== FrozenOutcome.UnstableOnBase || !proof.unstable) return [];
  return [
    `## ${story.storyId} (${story.outcome})`,
    ...[...failureSignatures(base).values()].map((error) => `- Base: ${error}`),
    ...[...failureSignatures(head).values()].map((error) => `- Head: ${error}`),
  ];
}

/**
 * Rechecks provisional parallel blocks on their assigned browsers after all workers drain.
 * The caller renders both sides without cache at the original clock and viewport.
 * Retain the original parallel evidence and apply the bounded repetition rule.
 */
export async function confirmParallelFrozenBlocks(stories, out, compare, source) {
  for (const [index, original] of stories.entries()) {
    if (original.outcome !== FrozenOutcome.Blocking || original.pixelStabilityBlocked) continue;
    const controls = [];
    const capture = async (count) => {
      const directory = path.join(out, "isolated-confirmation", `pair-${count}`);
      try {
        controls.push({ directory, comparison: await compare(original.storyId, directory, index) });
      } catch (error) {
        controls.push({ directory, error: String(error?.message ?? error).slice(0, 500) });
        return false;
      }
      return true;
    };
    if (await capture(1)) await capture(2);
    const proof = repeatedFailureState(combinedRenders(original, controls, "base"), combinedRenders(original, controls, "head"));
    const identical = !proof.basePassed && !proof.novelHead && confirmedIdentity(controls);
    const head = original.renders?.head;
    const originalFailure = head?.verdict === "FAIL" && head.failure?.type && head.failure?.message
      && fingerprint({ ...head, pixels: original.parallelFailurePixels });
    let preexisting;
    if (!identical && originalFailure && SHA.test(source?.base ?? "") && SHA.test(source?.head ?? "")) {
      for (let count = 3; count <= MAX_FRESH_PAIRS + 1; count++) {
        const proof = repeatedBaseOutcome(controls, original, originalFailure);
        if (proof.outcome || proof.contradictory || count > MAX_FRESH_PAIRS) {
          preexisting = proof.outcome;
          break;
        }
        if (!await capture(count)) break;
      }
    }
    const accepted = identical || Boolean(preexisting);
    const parallelConfirmation = { accepted, parallel: original, controls, source };
    if (identical) {
      stories[index] = { ...controls[1].comparison, reason: "two isolated base/head pairs matched with one successful render identity", parallelConfirmation };
    } else if (preexisting) {
      stories[index] = { ...original, outcome: preexisting, reason: preexisting === FrozenOutcome.SameFailure
        ? "play failed the same way with identical pixels in repeated fresh base and head contexts"
        : "every repeated base play failed and the base reproduced every observed head failure", parallelConfirmation };
    } else {
      stories[index] = { ...original, parallelConfirmation };
    }
  }
}
