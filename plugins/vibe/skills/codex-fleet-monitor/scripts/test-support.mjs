// Shared by the node:test suites in this directory; not used at runtime.

/**
 * The App Server's thread reads: `thread/read` returns turns only with includeTurns, `thread/turns/list` the
 * newest turns without items, `thread/items/list` a turn's newest items. With `legacy`, only `thread/read` exists.
 */
export function answerThreadRead(threads, method, params, { legacy = false } = {}) {
  const thread = threads[params?.threadId];
  if (!thread) throw new Error('no such thread');
  const turns = thread.turns ?? [];
  if (method === 'thread/read') return { thread: structuredClone({ ...thread, turns: params.includeTurns ? turns : [] }) };
  if (legacy) throw new Error(`Invalid request: unknown variant \`${method}\`, expected one of \`thread/read\``);
  if (method === 'thread/turns/list') {
    const newest = turns.slice(-(params.limit ?? turns.length)).reverse();
    return { data: newest.map((turn) => ({ ...structuredClone(turn), items: [], itemsView: 'notLoaded' })), nextCursor: null };
  }
  if (method === 'thread/items/list') {
    const items = turns.find((turn) => turn.id === params.turnId)?.items ?? [];
    return { data: items.slice(-(params.limit ?? items.length)).reverse().map((item) => ({ turnId: params.turnId, item })), nextCursor: null };
  }
  return undefined;
}
