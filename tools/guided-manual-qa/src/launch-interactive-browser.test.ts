import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSettledUrl,
  mergeStorageState,
  parseLaunchArguments,
  parseViewport,
  validateStorageFixture,
  verifyStorageFixture,
} from "./launch-interactive-browser.js";

const ORIGIN = "http://localhost:3000";
const REQUIRED = ["--url", `${ORIGIN}/path`, "--storage-file", "fixture.json"];

describe("parseViewport", () => {
  it("parses WIDTHxHEIGHT", () => {
    expect(parseViewport("1440x1000")).toEqual({ width: 1440, height: 1000 });
  });

  it.each(["1440", "1440X1000", "x1000", "-1x400", "1440x1000px"])("rejects malformed %s", (value) => {
    expect(() => parseViewport(value)).toThrow(/WIDTHxHEIGHT/);
  });

  it("rejects dimensions below 320", () => {
    expect(() => parseViewport("319x1000")).toThrow(/at least 320/);
    expect(() => parseViewport("1000x319")).toThrow(/at least 320/);
  });
});

describe("parseLaunchArguments", () => {
  it("applies defaults and resolves file paths", () => {
    const options = parseLaunchArguments(REQUIRED);
    expect(options).not.toBeNull();
    expect(options?.browser).toBe("chromium");
    expect(options?.stateName).toBe("manual-qa");
    expect(options?.storageFile).toBe(resolve("fixture.json"));
    expect(options?.url.href).toBe(`${ORIGIN}/path`);
    expect(options?.authState).toBeUndefined();
    expect(options?.readyFile).toBeUndefined();
    expect(options?.viewport).toBeUndefined();
  });

  it("parses every optional flag", () => {
    const options = parseLaunchArguments([
      ...REQUIRED,
      "--auth-state",
      "auth.json",
      "--channel",
      "chrome",
      "--ready-file",
      "ready.json",
      "--ready-selector",
      "[data-testid=board]",
      "--state-name",
      "flags-on",
      "--viewport",
      "1280x800",
    ]);
    expect(options).toMatchObject({
      authState: resolve("auth.json"),
      channel: "chrome",
      readyFile: resolve("ready.json"),
      readySelector: "[data-testid=board]",
      stateName: "flags-on",
      viewport: { width: 1280, height: 800 },
    });
  });

  it("returns null for --help", () => {
    expect(parseLaunchArguments(["--help"])).toBeNull();
  });

  it("requires --url and --storage-file", () => {
    expect(() => parseLaunchArguments(["--url", ORIGIN])).toThrow(/required/);
    expect(() => parseLaunchArguments(["--storage-file", "f.json"])).toThrow(/required/);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "chrome://settings"])("rejects non-HTTP URL %s", (url) => {
    expect(() => parseLaunchArguments(["--url", url, "--storage-file", "f.json"])).toThrow(/http or https/);
  });

  it("rejects unknown browsers and flags", () => {
    expect(() => parseLaunchArguments([...REQUIRED, "--browser", "edge"])).toThrow(/chromium, firefox, or webkit/);
    expect(() => parseLaunchArguments([...REQUIRED, "--bogus", "x"])).toThrow();
  });

  it("rejects a flag whose value is missing", () => {
    expect(() => parseLaunchArguments([...REQUIRED, "--state-name"])).toThrow();
  });

  it("allows --channel only with chromium", () => {
    expect(() => parseLaunchArguments([...REQUIRED, "--browser", "firefox", "--channel", "chrome"])).toThrow(
      /only with --browser chromium/,
    );
  });
});

describe("validateStorageFixture", () => {
  it("accepts an object of string values", () => {
    expect(validateStorageFixture({ flags: '{"a":true}', mode: "dark" })).toEqual({
      flags: '{"a":true}',
      mode: "dark",
    });
  });

  it.each([null, [], "text", 7])("rejects non-object %j", (value) => {
    expect(() => validateStorageFixture(value)).toThrow(/JSON object/);
  });

  it.each([{ a: 1 }, { a: true }, { a: { nested: "x" } }, { "": "x" }])("rejects entry %j", (value) => {
    expect(() => validateStorageFixture(value)).toThrow(/non-empty key and string value/);
  });
});

describe("mergeStorageState", () => {
  it("creates a fresh state when no auth state is given", () => {
    expect(mergeStorageState(undefined, ORIGIN, { b: "2", a: "1" })).toEqual({
      cookies: [],
      origins: [
        {
          origin: ORIGIN,
          localStorage: [
            { name: "a", value: "1" },
            { name: "b", value: "2" },
          ],
        },
      ],
    });
  });

  it("preserves cookies, other origins, and unrelated keys while overriding fixture keys", () => {
    const cookie = { name: "session", value: "secret", domain: "localhost" };
    const other = { origin: "http://localhost:4000", localStorage: [{ name: "x", value: "y" }] };
    const base = {
      cookies: [cookie],
      origins: [
        other,
        {
          origin: ORIGIN,
          localStorage: [
            { name: "keep", value: "k" },
            { name: "flag", value: "old" },
          ],
        },
      ],
    };
    const merged = mergeStorageState(base, ORIGIN, { flag: "new" });
    expect(merged.cookies).toEqual([cookie]);
    expect(merged.origins[0]).toEqual(other);
    expect(merged.origins[1]?.localStorage).toEqual([
      { name: "flag", value: "new" },
      { name: "keep", value: "k" },
    ]);
    // The input auth state is not mutated.
    expect(base.origins[1]?.localStorage).toEqual([
      { name: "keep", value: "k" },
      { name: "flag", value: "old" },
    ]);
  });

  it.each([{}, { cookies: [] }, { origins: [] }, [], "state"])("rejects invalid auth state %j", (value) => {
    expect(() => mergeStorageState(value, ORIGIN, {})).toThrow(/not a valid Playwright storage state/);
  });
});

describe("verifyStorageFixture", () => {
  const observed = {
    cookies: [],
    origins: [{ origin: ORIGIN, localStorage: [{ name: "flag", value: "on" }] }],
  };

  it("passes when every fixture key matches", () => {
    expect(() => verifyStorageFixture(observed, ORIGIN, { flag: "on" })).not.toThrow();
  });

  it("names only the failing key, never its value", () => {
    expect(() => verifyStorageFixture(observed, ORIGIN, { flag: "off" })).toThrow(
      "Browser storage verification failed for key: flag",
    );
  });

  it("fails when the origin is absent", () => {
    expect(() => verifyStorageFixture({ cookies: [], origins: [] }, ORIGIN, { flag: "on" })).toThrow(/key: flag/);
  });
});

describe("assertSettledUrl", () => {
  const target = new URL(`${ORIGIN}/board`);

  it("accepts the same origin and path, ignoring ordinary query strings", () => {
    expect(() => assertSettledUrl(new URL(`${ORIGIN}/board?tab=1`), target)).not.toThrow();
  });

  it.each([
    "http://localhost:3001/board",
    `${ORIGIN}/sign-in`,
    `${ORIGIN}/board?__clerk_handshake=abc`,
  ])("rejects %s", (settled) => {
    expect(() => assertSettledUrl(new URL(settled), target)).toThrow(/did not settle/);
  });
});
