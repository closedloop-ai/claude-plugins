import assert from "node:assert/strict";
import test from "node:test";
import { LinkSource, MissingLink, pageLink, storyLink } from "./person-links.mjs";

const DEPLOYED_STORYBOOK = "https://prototypes-git-vibe-tour.preview.closedloop-stage.ai/storybook";
const DEPLOYED_APP = "https://app-stage-git-vibe-tour.preview.closedloop-stage.ai";
const LOCAL_STORYBOOK = "http://localhost:6123";
const LOCAL_PID = 4242;
const STORY = "composites-guided-tour--mid-run";
const running = (pid) => pid === LOCAL_PID;

// An unverified record still carries the branch's predicted aliases; only a
// verified environment counts as deployed.
function record({ verified = false, local = false } = {}) {
  return {
    vercel: {
      appUrl: DEPLOYED_APP,
      apiUrl: "https://api-stage-git-vibe-tour.preview.closedloop-stage.ai",
      storybookUrl: DEPLOYED_STORYBOOK,
      verifiedAt: verified ? "2026-10-28T15:00:00Z" : null,
    },
    stack: local ? { storybookUrl: LOCAL_STORYBOOK, storybookPid: LOCAL_PID } : null,
  };
}

test("a story link opens the full Storybook UI on the deployed Storybook when the environment is verified", () => {
  assert.deepEqual(storyLink(record({ verified: true, local: true }), STORY, { isRunning: running }), {
    url: `${DEPLOYED_STORYBOOK}/?path=/story/${STORY}`,
    source: LinkSource.Deployed,
  });
});

test("a story link uses the local Storybook while nothing is deployed, and on --local", () => {
  const expected = { url: `${LOCAL_STORYBOOK}/?path=/story/${STORY}`, source: LinkSource.Local };
  assert.deepEqual(storyLink(record({ local: true }), STORY, { isRunning: running }), expected);
  assert.deepEqual(storyLink(record({ verified: true, local: true }), STORY, { local: true, isRunning: running }), expected);
});

test("a story link is missing when no Storybook is deployed or running", () => {
  const missing = { url: null, missing: MissingLink.Storybook };
  assert.deepEqual(storyLink(record(), STORY, { isRunning: running }), missing);
  assert.deepEqual(storyLink({ vercel: null, stack: null }, STORY, { isRunning: running }), missing);
  const stopped = { ...record(), stack: { storybookUrl: LOCAL_STORYBOOK, storybookPid: 7 } };
  assert.deepEqual(storyLink(stopped, STORY, { isRunning: running }), missing);
  assert.deepEqual(storyLink(record({ verified: true }), STORY, { local: true, isRunning: running }), missing);
  const noUrl = { ...record(), stack: { storybookPid: LOCAL_PID } };
  assert.deepEqual(storyLink(noUrl, STORY, { isRunning: running }), missing);
});

test("a story link trims a trailing slash from the recorded base", () => {
  const slashed = { vercel: { storybookUrl: `${DEPLOYED_STORYBOOK}/`, verifiedAt: "2026-10-28T15:00:00Z" } };
  assert.equal(storyLink(slashed, STORY, { isRunning: running }).url, `${DEPLOYED_STORYBOOK}/?path=/story/${STORY}`);
});

test("a story link refuses anything that is not a story id", () => {
  for (const id of ["guided-tour-mid-run", "Composites/Guided Tour", "composites-guided-tour--", "a--b?x=1", "", undefined]) {
    assert.throws(() => storyLink(record({ verified: true }), id, { isRunning: running }), /Not a Storybook story id/, String(id));
  }
});

test("a page link is the verified app URL plus the real page path", () => {
  const verified = record({ verified: true });
  assert.deepEqual(pageLink(verified, "/acme-co/documents/ISS-42"), {
    url: `${DEPLOYED_APP}/acme-co/documents/ISS-42`,
    source: LinkSource.Deployed,
  });
  assert.equal(pageLink(verified, "/acme-co/sessions?tab=active#top").url, `${DEPLOYED_APP}/acme-co/sessions?tab=active#top`);
  assert.equal(pageLink(verified, "/").url, DEPLOYED_APP);
});

test("a page link is missing until the app is deployed, including a prototype session's null vercel", () => {
  const missing = { url: null, missing: MissingLink.App };
  assert.deepEqual(pageLink(record({ local: true }), "/acme-co/sessions"), missing);
  assert.deepEqual(pageLink({ vercel: null }, "/acme-co/sessions"), missing);
});

test("a page link refuses a route pattern or anything that is not a path on the app", () => {
  const verified = record({ verified: true });
  for (const pattern of ["/[orgSlug]/documents/[id]", "/acme-co/documents/:id", "/acme-co/<id>", "/acme-co/{id}", "/docs/[[...slug]]", "/acme-co/%5Bid%5D"]) {
    assert.throws(() => pageLink(verified, pattern), /route pattern/, pattern);
  }
  for (const path of ["acme-co/sessions", "//evil.example/x", "https://evil.example/x", "/acme-co/../x", "/a b", "/%E0%A4%A", "", undefined]) {
    assert.throws(() => pageLink(verified, path), /Not a page path/, String(path));
  }
});
