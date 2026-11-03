// Path prefixes of the target repository's UI surfaces, shared by the handoff facts (pr-facts.mjs) and the
// triage manifest (vibe-triage.mjs) so the two cannot drift.

export const UI_PREFIXES = ["apps/app/", "apps/web/", "apps/storybook/", "apps/prototypes/", "apps/desktop/src/renderer/", "packages/app/", "packages/design-system/"];

/** The surfaces Desktop hosts: its renderer and the shared product UI package. */
export const DESKTOP_HOST = ["apps/desktop/src/renderer/", "packages/app/"];

/** Backend paths: the one list triage and the handoff inventory both read. */
export const BACKEND_PATH = /^apps\/(api|mcp|relay|realtime|doc-sync)\/|^packages\/(database|api|github|ai|loops-api|cost)\/|^apps\/desktop\/src\/(main|server)\/|\.sql$|schema\.prisma$/;
