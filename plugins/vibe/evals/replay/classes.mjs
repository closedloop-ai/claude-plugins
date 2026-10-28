// Task classes the replay corpus is stratified by (plan section 4 class table).
// This groups merged tickets for fair coverage; it is not the vibe-triage
// classifier (T1), which decides a live session's pipeline.

export const TaskClass = {
  TrivialUi: "trivial-ui",
  UiFeature: "ui-feature",
  Backend: "backend",
  DocsConfig: "docs-config",
  Mockup: "mockup",
  DataMetric: "data-metric",
};

export const TRIVIAL_UI_MAX_FILES = 1;
export const TRIVIAL_UI_MAX_LINES = 10;

const DOCS_CONFIG = /(^|\/)(docs|\.claude|\.agents|\.github)\/|\.(md|mdx|ya?ml|json|toml)$|(^|\/)(AGENTS|CLAUDE)\.md$/;
const MOCKUP = /^apps\/prototypes\//;
const UI = /^(packages\/app|packages\/design-system|apps\/app|apps\/web|apps\/storybook|apps\/desktop\/src\/renderer)\/|\.(tsx|css|scss)$/;
const BACKEND = /^(apps\/api|apps\/mcp|apps\/relay|apps\/realtime|packages\/database|packages\/api|apps\/desktop\/src\/(main|server))\//;
const METRIC = /(cost|metric|analytics|usage|stickiness|dashboard)/i;

/** Classifies a merged change from its files (`[{path, additions, deletions}]`). */
export function classifyFiles(files) {
  if (files.length === 0) return null;
  const paths = files.map((file) => file.path);
  if (paths.every((file) => MOCKUP.test(file))) return TaskClass.Mockup;
  if (paths.every((file) => DOCS_CONFIG.test(file) && !UI.test(file))) return TaskClass.DocsConfig;
  const touchesUi = paths.some((file) => UI.test(file));
  const touchesBackend = paths.some((file) => BACKEND.test(file));
  if (touchesUi && paths.some((file) => METRIC.test(file))) return TaskClass.DataMetric;
  if (touchesUi && !touchesBackend) {
    const lines = files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
    return files.length <= TRIVIAL_UI_MAX_FILES && lines <= TRIVIAL_UI_MAX_LINES ? TaskClass.TrivialUi : TaskClass.UiFeature;
  }
  if (touchesUi) return TaskClass.UiFeature;
  return touchesBackend ? TaskClass.Backend : TaskClass.DocsConfig;
}
