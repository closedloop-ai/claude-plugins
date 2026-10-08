#!/usr/bin/env node
// Resolves the PostHog public project key (`phc_`) and API host the vibe
// environment worker evaluates the production flag snapshot with (ISS-12048).
// The key is public: it ships in every browser bundle of the product. Order:
//   1. a checkout's `apps/app/.env.local`, when it holds a valid `phc_` key;
//   2. the public production app's sign-in page, which embeds the key and the
//      API host in its PostHog provider props.
// Never needs a Vercel sign-in. Prints one JSON object
// {"ok":true,"key":...,"host":...,"source":...} or {"ok":false,"error":...}
// and exits non-zero when neither source has a valid key.
//
// Usage: posthog-key.mjs [--checkout <path> ...] [--page-url <url>]
// `--checkout` may repeat (a session worktree, then its main checkout);
// `--page-url` (or VIBE_POSTHOG_PAGE_URL) replaces the production page, for
// tests.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const PRODUCTION_PAGE_URL = "https://app.closedloop.ai/sign-in";
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const ENV_FILE = path.join("apps", "app", ".env.local");
const POSTHOG_KEY = /^phc_[A-Za-z0-9]{20,100}$/;
const POSTHOG_HOST = /^https:\/\/[a-z0-9-]+(?:\.i)?\.posthog\.com$/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
// The page's RSC payload escapes quotes (`\"apiKey\":\"phc_...\"`); plain
// JSON does not. Both shapes are matched.
const PAGE_KEY = /\\?"apiKey\\?"\s*:\s*\\?"(phc_[A-Za-z0-9]+)\\?"/;
const PAGE_HOST = /\\?"api_host\\?"\s*:\s*\\?"(https:\/\/[^"\\]+)\\?"/;
const FETCH_TIMEOUT_MS = 15_000;

/** The `phc_` key and host from an env file's text, or null when it has no valid key. */
export function keyFromEnvText(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = ENV_LINE.exec(line);
    if (match && !line.trimStart().startsWith("#")) {
      values[match[1]] = unquote(match[2]);
    }
  }
  const key = values.NEXT_PUBLIC_POSTHOG_KEY;
  if (!POSTHOG_KEY.test(key ?? "")) {
    return null;
  }
  return { key, host: normalizeHost(values.NEXT_PUBLIC_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST };
}

/** The `phc_` key and host embedded in the production page, or null when either is missing or invalid. */
export function keyFromPageText(text) {
  const key = PAGE_KEY.exec(text)?.[1];
  const host = normalizeHost(PAGE_HOST.exec(text)?.[1]);
  if (!POSTHOG_KEY.test(key ?? "") || !host) {
    return null;
  }
  return { key, host };
}

function unquote(value) {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
}

function normalizeHost(value) {
  const host = (value ?? "").replace(/\/+$/, "");
  return POSTHOG_HOST.test(host) ? host : null;
}

export async function resolvePosthogKey({ checkouts, pageUrl, fetchImpl = fetch }) {
  for (const checkout of checkouts) {
    const file = path.join(checkout, ENV_FILE);
    if (existsSync(file)) {
      const found = keyFromEnvText(readFileSync(file, "utf8"));
      if (found) {
        return { ...found, source: file };
      }
    }
  }
  let page;
  try {
    const response = await fetchImpl(pageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    page = await response.text();
  } catch (error) {
    throw new Error(
      `No PostHog key in ${checkouts.length ? checkouts.map((c) => path.join(c, ENV_FILE)).join(", ") : "any checkout"}, and ${pageUrl} could not be read: ${error instanceof Error ? error.message : String(error)}.`
    );
  }
  const found = keyFromPageText(page);
  if (!found) {
    throw new Error(`No PostHog key in the checkout's env file, and ${pageUrl} has no phc_ key with a PostHog API host.`);
  }
  return { ...found, source: pageUrl };
}

async function main() {
  const { values } = parseArgs({
    options: {
      checkout: { type: "string", multiple: true },
      "page-url": { type: "string" },
    },
  });
  try {
    const result = await resolvePosthogKey({
      checkouts: values.checkout ?? [],
      pageUrl: values["page-url"] ?? process.env.VIBE_POSTHOG_PAGE_URL ?? PRODUCTION_PAGE_URL,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
