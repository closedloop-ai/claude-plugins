/**
 * A plugin registers at most one hook command per event: one script per event
 * that reads stdin once and routes to its guards internally. Separate commands
 * for one event run in parallel, each paying its own process start, and their
 * decisions are merged by Claude Code rather than by the plugin. CI fails while
 * any plugin registers more than one handler for an event, counted across every
 * matcher group and every hook source the plugin ships: each hooks.json in the
 * plugin tree (Claude's hooks/hooks.json and any Codex hooks.json) and a `hooks`
 * field in either plugin manifest, given as a path, a list of paths, or inline.
 * There are no exceptions.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CLAUDE_MANIFEST, CODEX_MANIFEST } from "./manifest-versions.js";

export const HOOKS_FILE = "hooks.json";

export interface HookRegistrationProblem {
  plugin: string;
  event: string;
  count: number;
  sources: string[];
}

type EventCounts = Map<string, { count: number; sources: Set<string> }>;

export function findHookRegistrationProblems(pluginsDir: string): HookRegistrationProblem[] {
  const problems: HookRegistrationProblem[] = [];
  const plugins = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const plugin of plugins) {
    const counts = countHandlers(join(pluginsDir, plugin));
    for (const event of [...counts.keys()].sort()) {
      const { count, sources } = counts.get(event) ?? { count: 0, sources: new Set<string>() };
      if (count > 1) problems.push({ plugin, event, count, sources: [...sources].sort() });
    }
  }
  return problems;
}

export function formatHookProblem({ plugin, event, count, sources }: HookRegistrationProblem): string {
  return `plugins/${plugin}: ${event} registers ${count} hook handlers (${sources.join(", ")}), allowed 1; register one script for the event and route to each handler inside it`;
}

function countHandlers(pluginDir: string): EventCounts {
  const counts: EventCounts = new Map();
  const seen = new Set<string>();
  const add = (config: unknown, source: string): void => {
    for (const [event, groups] of Object.entries(eventMap(config))) {
      const handlers = Array.isArray(groups) ? groups.reduce<number>((sum, group) => sum + handlerCount(group), 0) : 0;
      if (handlers === 0) continue;
      const entry = counts.get(event) ?? { count: 0, sources: new Set<string>() };
      entry.count += handlers;
      entry.sources.add(source);
      counts.set(event, entry);
    }
  };
  const addFile = (path: string): void => {
    const absolute = resolve(path);
    if (seen.has(absolute) || !existsSync(absolute)) return;
    seen.add(absolute);
    add(JSON.parse(readFileSync(absolute, "utf8")), relative(pluginDir, absolute));
  };
  for (const file of hookFiles(pluginDir)) addFile(file);
  for (const manifest of [CLAUDE_MANIFEST, CODEX_MANIFEST]) {
    const manifestPath = join(pluginDir, manifest);
    if (!existsSync(manifestPath)) continue;
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const hooks = isRecord(parsed) ? parsed.hooks : undefined;
    const paths = typeof hooks === "string" ? [hooks] : Array.isArray(hooks) ? hooks : [];
    for (const path of paths) if (typeof path === "string") addFile(join(pluginDir, path));
    if (isRecord(hooks)) add(hooks, `${manifest} (inline hooks)`);
  }
  return counts;
}

function hookFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...hookFiles(path));
    else if (entry.name === HOOKS_FILE) files.push(path);
  }
  return files.sort();
}

/** The event-to-groups map of a hook config: `{ hooks: { Event: [...] } }`, or the bare map when inline. */
function eventMap(config: unknown): Record<string, unknown> {
  if (!isRecord(config)) return {};
  return isRecord(config.hooks) ? config.hooks : config;
}

function handlerCount(group: unknown): number {
  return isRecord(group) && Array.isArray(group.hooks) ? group.hooks.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
