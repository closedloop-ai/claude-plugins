import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { keyFromEnvText, keyFromPageText } from "./posthog-key.mjs";
import { makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "posthog-key.mjs");
const KEY = "phc_TestKey0123456789abcdefghijklmnopqrstu";
// The shape the production sign-in page embeds: the RSC payload escapes quotes.
const RSC_PAGE = `self.__next_f.push([1,"21:[\\"$\\",\\"$L23\\",null,{\\"apiKey\\":\\"${KEY}\\",\\"options\\":{\\"capture_pageview\\":false,\\"api_host\\":\\"https://us.i.posthog.com\\"}}]"])`;

test("an env file's key and host are read, quoted or not, and a missing or commented key is not", () => {
  assert.deepEqual(
    keyFromEnvText(`NEXT_PUBLIC_POSTHOG_KEY=${KEY}\nNEXT_PUBLIC_POSTHOG_HOST="https://us.posthog.com/"\n`),
    { key: KEY, host: "https://us.posthog.com" }
  );
  assert.deepEqual(keyFromEnvText(`export NEXT_PUBLIC_POSTHOG_KEY='${KEY}'\n`), {
    key: KEY,
    host: "https://us.i.posthog.com",
  });
  assert.equal(keyFromEnvText(`# NEXT_PUBLIC_POSTHOG_KEY=${KEY}\n`), null);
  assert.equal(keyFromEnvText("NEXT_PUBLIC_POSTHOG_KEY=\n"), null);
  assert.equal(keyFromEnvText("NEXT_PUBLIC_POSTHOG_KEY=sk_live_not_a_public_key_000000\n"), null);
  assert.deepEqual(
    keyFromEnvText(`NEXT_PUBLIC_POSTHOG_KEY=${KEY}\nNEXT_PUBLIC_POSTHOG_HOST=https://evil.example.com\n`),
    { key: KEY, host: "https://us.i.posthog.com" }
  );
});

test("the production page's key is read only with a PostHog API host", () => {
  assert.deepEqual(keyFromPageText(RSC_PAGE), { key: KEY, host: "https://us.i.posthog.com" });
  assert.deepEqual(keyFromPageText(`{"apiKey":"${KEY}","api_host":"https://eu.i.posthog.com/"}`), {
    key: KEY,
    host: "https://eu.i.posthog.com",
  });
  assert.equal(keyFromPageText(`{"apiKey":"${KEY}","api_host":"https://collect.example.com"}`), null);
  assert.equal(keyFromPageText(`{"apiKey":"${KEY}"}`), null);
  assert.equal(keyFromPageText('{"apiKey":"pk_123","api_host":"https://us.i.posthog.com"}'), null);
  assert.equal(keyFromPageText("<html>no key here</html>"), null);
});

function servePage(t, body, status = 200) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end(body);
  });
  t.after(() => server.close());
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/sign-in`));
  });
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, VIBE_POSTHOG_PAGE_URL: "" } });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, json: JSON.parse(stdout) }));
  });
}

function checkoutWithEnv(root, name, text) {
  const checkout = path.join(root, name);
  mkdirSync(path.join(checkout, "apps", "app"), { recursive: true });
  if (text !== undefined) {
    writeFileSync(path.join(checkout, "apps", "app", ".env.local"), text);
  }
  return checkout;
}

test("the CLI prefers a checkout's env file, then the production page, and fails plainly without either", async (t) => {
  const fixture = makeHome("vibe-posthog-");
  t.after(fixture.cleanup);
  const page = await servePage(t, RSC_PAGE);
  const fresh = checkoutWithEnv(fixture.root, "fresh worktree");
  const main = checkoutWithEnv(fixture.root, "main checkout", `NEXT_PUBLIC_POSTHOG_KEY=${KEY}\n`);

  const fromEnv = await run(["--checkout", fresh, "--checkout", main, "--page-url", page]);
  assert.equal(fromEnv.status, 0);
  assert.equal(fromEnv.json.key, KEY);
  assert.equal(fromEnv.json.source, path.join(main, "apps", "app", ".env.local"));

  const fromPage = await run(["--checkout", fresh, "--page-url", page]);
  assert.equal(fromPage.status, 0);
  assert.deepEqual(fromPage.json, { ok: true, key: KEY, host: "https://us.i.posthog.com", source: page });

  const emptyPage = await servePage(t, "<html>nothing</html>");
  const missing = await run(["--checkout", fresh, "--page-url", emptyPage]);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /has no phc_ key with a PostHog API host/);

  const down = await servePage(t, "error", 503);
  const unreachable = await run(["--checkout", fresh, "--page-url", down]);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.json.error, /could not be read: HTTP 503/);
});
