// The running Codex's own model list, which `model-policy.mjs` `availableCodexModel` checks a worker's model
// against before the worker starts. It asks the Codex App Server (`model/list`, every page) through a private
// `codex app-server` on stdio, or through a client a caller already holds, and never guesses from the CLI's
// version number. A list that cannot be read is `{ error }`, never a throw: the caller then uses the fallback.

import { findCli, BUNDLED_CODEX } from '../../vibe/scripts/plugin-cli.mjs';
import { availableCodexModel } from './model-policy.mjs';
import { vibeCore } from '../../../shared/vibe-core.mjs';

const { connectStdio } = await vibeCore('lib/codex-fleet-monitor/scripts/liveness.mjs');

const DEFAULT_TIMEOUT_MS = 20_000;
// A Codex lists about ten models on one page; this only stops a server that never ends its pages.
const MAX_PAGES = 20;

/** Every model id one `model/list` page names (each entry's `model` and `id`), or null when the page is not a list. */
export function pageModels(page) {
  if (!page || !Array.isArray(page.data)) return null;
  const names = [];
  for (const entry of page.data) {
    for (const name of [entry?.model, entry?.id]) {
      if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Reads every page through `client.request`; resolves `{ models }` or `{ error }`, never throws. */
export async function listModels(client, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const models = [];
  let cursor = null;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await client.request('model/list', cursor ? { cursor } : {}, timeoutMs);
      const names = pageModels(result);
      if (!names) return { error: 'model/list returned no model list' };
      for (const name of names) if (!models.includes(name)) models.push(name);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) return { models };
    }
    return { error: `model/list did not end within ${MAX_PAGES} pages` };
  } catch (error) {
    return { error: `model/list failed: ${error.message}` };
  }
}

/**
 * The model list of the Codex CLI a worker runs on (`codex`, else the one on this machine), read through a private
 * App Server. Resolves `{ models }` or `{ error }`; never throws.
 */
export async function readModelCatalog({ codex, timeoutMs = DEFAULT_TIMEOUT_MS, connect = connectStdio } = {}) {
  const cli = codex ?? findCli('codex') ?? BUNDLED_CODEX;
  let client;
  try {
    client = connect(cli);
    await client.initialize(timeoutMs);
  } catch (error) {
    client?.close();
    return { error: `initialize failed: ${error.message}` };
  }
  try {
    return await listModels(client, timeoutMs);
  } finally {
    client.close();
  }
}

/**
 * A cl-sweep `init` (or `replace`) from the command line, the same in every transport: reads the Codex CLI's model
 * list, runs `create(modelCatalog)`, and returns the saved session plus `modelNote`, the one launch line, when the
 * session started on a fallback (`requestedModelFallbackFrom`).
 */
export async function startWithModelList(codex, create) {
  const modelCatalog = await readModelCatalog({ codex });
  const session = create(modelCatalog);
  const from = session.requestedModelFallbackFrom;
  const { note } = from ? availableCodexModel(from, modelCatalog) : {};
  return note ? { ...session, modelNote: note } : session;
}
