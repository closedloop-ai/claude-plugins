# Browser State Fixtures

Read this reference when a manual QA matrix depends on local storage, cookies, feature-flag overrides, authentication state, or another per-origin browser fixture.

## Preferred order

1. Use a repository-provided QA control or documented fixture launcher when one exists.
2. Otherwise, use the repository's installed Playwright to create a dedicated interactive browser context with state populated before the first application navigation.
3. If neither path is supported, mark the affected setup and checkpoints `BLOCKED`. Do not ask the human to use DevTools as routine setup and do not bypass a browser safety refusal.

## Preload per-origin local storage

Playwright accepts an in-memory `storageState` object whose `origins` entries contain `localStorage` name/value pairs. Construct the state from the explicit QA matrix and pass it when creating the browser context:

```ts
const context = await browser.newContext({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: targetOrigin,
        localStorage: Object.entries(storageFixture).map(([name, value]) => ({
          name,
          value,
        })),
      },
    ],
  },
});
```

Values in Web Storage are strings. Serialize structured fixtures once, before building the entries. Validate the target with `new URL()` and use its exact `.origin`; never accept an arbitrary script or expression as fixture input.

The bundled launcher implements this path without writing browser state into the repository. Run it with the bootstrapped repository root as the working directory. Its path is relative to the skill directory, so resolve the absolute path as SKILL.md describes:

```bash
node "<absolute skill directory>/scripts/dist/launch-interactive-browser.mjs" \
  --url 'http://localhost:3000/path-under-test' \
  --storage-file /private/untracked/storage-fixture.json \
  --state-name 'flag-matrix-state' \
  --ready-file /private/untracked/browser-ready.json \
  --channel chrome \
  --viewport 1440x1000
```

The storage fixture is a JSON object whose values are already-serialized strings. The launcher resolves Playwright from the bootstrapped current repository, rejects non-HTTP(S) URLs and non-string storage values, verifies the loaded keys through `context.storageState()`, and prints only key names, never values. Pass `--auth-state` only for a repository-supported private Playwright state file.

For an authenticated route, pass `--ready-selector` with a CSS locator for a visible control owned by that route. The launcher waits for it, then checks the settled origin and path and refuses a Clerk handshake redirect before writing its ready artifact. An initial `domcontentloaded` URL can still leave the app; do not count human evidence until the settled control and origin are verified.

When authentication already comes from a repository-supported Playwright storage-state file, load that JSON privately, preserve its cookies and unrelated origins, and merge only the named QA entries into the target origin. Write the merged copy to a temporary or user-state path outside the repository. Never print, commit, attach, or quote authentication state.

## Interactive session

The human explicitly requesting interactive manual QA authorizes a visible application window for that session; this does not authorize visible automated E2E. Launch a fresh Playwright browser and context for the interactive session, with `headless: false` only for that intentional human walkthrough. Keep automated suites headless or displayless according to repository policy.

Use a new temporary or dedicated QA profile/context rather than the human's normal Chrome profile. Playwright warns that automating the default Chrome user-data directory is unsupported. Record the browser channel and that the profile was disposable, but do not record profile contents.

For a multi-state matrix, prefer a fresh context per state so state does not leak between cases. If the installed Playwright version supports the dedicated `page.localStorage` API, it may update a named key for the current origin followed by a reload; version-check this API first. Do not fall back to page-evaluated scripts, `javascript:` navigation, raw CDP, or DevTools Console steps.

Before presenting the checkpoint, verify the loaded fixture through the same supported storage API or an application-visible assignment indicator. Record that verification as `automated` or `agent-observed`; the human still confirms the product behavior.

## Record and cleanup

Record:

- exact origin and browser channel;
- fixture source and non-secret key names;
- matrix state name and serialized values when they are safe to retain;
- whether state was created fresh or merged with private auth state;
- verification method and result;
- temporary state/profile path and cleanup result.

Delete disposable state and profiles after the walkthrough. Preserve a private auth-state source only when repository policy already requires it; never treat a generated QA copy as durable credentials.

## Primary documentation

- Playwright `storageState` supports `origins[].localStorage`: https://playwright.dev/docs/api/class-testoptions#test-options-storage-state
- Playwright authentication state includes local storage: https://playwright.dev/docs/auth
- Playwright WebStorage API: https://playwright.dev/docs/api/class-webstorage
- Playwright persistent contexts and the default-profile warning: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
