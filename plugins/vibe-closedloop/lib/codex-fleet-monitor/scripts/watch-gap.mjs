// The watcher publishes a gap in its snapshot; only a complete, in-window pmset pair can queue a sleep notice.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { canonicalHome, commandChat, programChats, validChat } from "../../fleet-orchestrator/scripts/chat-binding.mjs";
import { hookStatePath } from "../../../hooks/hook-session-scope.mjs";
import { transcriptLines, transcriptPosition } from "../../../hooks/skill-transcript.mjs";
import { regularJson, writeAtomic } from "../../vibe/scripts/owned-state.mjs";
import { resolveWorkDir } from "./work-dir.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { processIdentityStatus, readProcessIdentity } from "../../../shared/process-identity.mjs";

const DISPLAY_TIME = /^([01]\d|2[0-3]):[0-5]\d [A-Za-z0-9+:-]+$/;
const NOTICE_ID = /^(\d{1,10})-(\d{1,10})-[a-f0-9-]{36}$/;

/** Bound owners use their program queue. Launching chats find their queue in private hook state. */
function noticeDirectory(programDir, chat) {
  const root = programDir ? path.join(programDir, "pending-watcher-sleeps")
    : path.dirname(hookStatePath(chat, "watcher-sleeps"));
  return path.join(root, `chat-${chat}`);
}

function clock(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  });
}

function duration(seconds) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Stream the potentially large system log. Maintenance dark wakes do not end an overnight sleep. */
async function confirmedSleep(start, end) {
  const command = spawn("pmset", ["-g", "log"], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  const success = new Promise(resolve => {
    command.once("error", () => resolve(false));
    command.once("close", code => resolve(code === 0));
  });
  let slept = null;
  let longest = null;
  try {
    for await (const line of createInterface({ input: command.stdout, crlfDelay: Infinity })) {
      const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d{4})\s+(Sleep\s+Entering Sleep state|Wake\s+(?:Wake from|DarkWake to FullWake))\b/.exec(line);
      if (!match) continue;
      const local = `${match[1]}T${match[2]}`;
      const when = Date.parse(local + match[3]) / 1000;
      if (!Number.isFinite(when) || when < start || when > end) continue;
      // Date.parse normalizes impossible days and 24:00. Compare the original wall time before applying its offset.
      if (new Date(local + "Z").toISOString().slice(0, 19) !== local) continue;
      if (match[4].startsWith("Sleep")) {
        slept ??= when;
      } else {
        if (slept !== null && when > slept && (!longest || when - slept > longest.woke - longest.slept)) {
          longest = { slept, woke: when };
        }
        slept = null;
      }
    }
  } catch {
    // A broken stream cannot confirm sleep, even if it yielded a complete pair before the error.
    return null;
  }
  return await success ? longest : null;
}

/** First line is the snapshot row. The optional second line holds confirmations awaiting receipt creation. */
function readGap(dir) {
  try {
    const [line, pending] = readFileSync(path.join(dir, "watch-gap"), "utf8").split("\n");
    return { line, pending: pending ? JSON.parse(pending) : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { line: null, pending: [] };
    throw error;
  }
}

/** The single writer commits the event and all unsent owners and endpoints in one replacement. */
function publishGap(dir, line, pending) {
  const file = path.join(dir, "watch-gap");
  const temp = `${file}.${randomUUID()}.tmp`;
  const backlog = pending.length ? `${JSON.stringify(pending)}\n` : "";
  writeFileSync(temp, `${line}\n${backlog}`, { flag: "wx", mode: 0o600, flush: true });
  try {
    renameSync(temp, file);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

/** Capture the original owner together with confirmed endpoints before publishing the tick. */
async function recordGap(dir, start, end, platform, oldest, reported) {
  const pair = platform === "Darwin" ? await confirmedSleep(start, end) : null;
  let notice = null;
  let event = `WATCH-GAP ${duration(end - start)}`;
  if (pair) {
    const slept = clock(pair.slept);
    const woke = clock(pair.woke);
    event = `SLEPT ${duration(pair.woke - pair.slept)} (sleep ${slept}, wake ${woke})`;
    const { home, program } = resolveWorkDir(canonicalHome(dir));
    const holder = program && programChats(home, program)[0];
    const owner = holder || commandChat();
    if (validChat(owner)) {
      const id = `${pair.slept}-${pair.woke}-${randomUUID()}`;
      notice = { id, slept, woke, owner, bound: Boolean(holder) };
    }
  }
  const sample = { line: `watch-gap ${start}-${end} ${event}`, notice };
  const file = path.join(dir, `watch-window.${start}-${end}.pending`);
  // Retry a transient write with this exact sample before the watcher advances its clock.
  let staged;
  try {
    staged = stageWindow(file, sample);
  } catch {
    staged = stageWindow(file, sample);
  }
  // A clock correction can make the new window earlier than the queued one.
  const queued = oldest && oldest !== file && /^watch-window\.(\d+)-(\d+)(?:\.sample)?\.pending$/.exec(path.basename(oldest));
  const queuedFirst = queued && (Number(queued[1]) < start || (Number(queued[1]) === start && Number(queued[2]) <= end));
  retryWindow(dir, queuedFirst ? oldest : staged, reported);
}

function alternateWindow(file) {
  return file.replace(/\.pending$/, ".sample.pending");
}

/** Store the entire sample in one filesystem operation, preserving any complete same-window journal. */
function stageWindow(file, sample) {
  const alternate = alternateWindow(file);
  if (readWindow(alternate)) {
    if (readWindow(file) === null) renameSync(file, `${file}.incomplete`);
    return alternate;
  }
  const contents = JSON.stringify(sample);
  try {
    symlinkSync(contents, file);
    return file;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (readWindow(file)) return file;
  }
  // Keep a recoverable replacement before moving the truncated record aside.
  try {
    symlinkSync(contents, alternate);
  } catch (error) {
    if (error.code !== "EEXIST" || !readWindow(alternate)) throw error;
  }
  renameSync(file, `${file}.incomplete`);
  return alternate;
}

/** Read a link as data. Null is truncated legacy JSON and undefined is a missing entry. */
function readWindow(file) {
  let link;
  try {
    link = lstatSync(file).isSymbolicLink();
    return link ? JSON.parse(readlinkSync(file)) : regularJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (link || !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/** Only the watcher lock holder updates the snapshot. Replaying an already committed window is idempotent. */
function commitWindow(dir, sample, reported) {
  const { line, pending } = readGap(dir);
  if (line === sample.line) return true;
  // A prior watcher can exit after publication but before its last-snapshot update.
  if (line && line !== reported) return false;
  publishGap(dir, sample.line, sample.notice ? [...pending, sample.notice] : pending);
  return true;
}

/** Report at most one saved window per tick so the normal snapshot diff observes each one. */
function retryWindow(dir, file, reported) {
  try {
    let sample = readWindow(file);
    if (sample === null) {
      renameSync(file, `${file}.incomplete`);
      file = alternateWindow(file);
      sample = readWindow(file);
    }
    if (sample && commitWindow(dir, sample, reported)) unlinkSync(file);
  } catch (error) {
    process.stderr.write(`watch.sh: gap publication pending: ${error.message}\n`);
  }
}

/** Remove staged receipts from the durable backlog before any prompt can claim them.
 * A crash before that commit merely rewrites the same receipt under the watcher lock.
 */
function retryNotices(dir, retries) {
  const { line, pending } = readGap(dir);
  const remaining = [];
  const files = new Set(retries);
  for (const record of pending) {
    if (!NOTICE_ID.test(record?.id) || !validChat(record.owner)) throw new Error("invalid pending watcher notice");
    const file = path.join(dir, `watch-sleep.${record.id}.retry`);
    try {
      writeAtomic(file, record);
      files.add(file);
    } catch (error) {
      remaining.push(record);
      files.delete(file);
      process.stderr.write(`watch.sh: sleep notice receipt pending: ${error.message}\n`);
    }
  }
  if (remaining.length !== pending.length) publishGap(dir, line, remaining);
  for (const file of files) {
    try { routeNotice(file); } catch (error) {
      if (error.code !== "ENOENT") process.stderr.write(`watch.sh: sleep notice delivery pending: ${error.message}\n`);
    }
  }
}

/** The queue points back to the one claimable receipt in the work dir, even across filesystems. */
function routeNotice(file) {
  const dir = path.dirname(file);
  const id = path.basename(file).slice("watch-sleep.".length, -".retry".length);
  if (!NOTICE_ID.test(id)) return;
  const record = regularJson(file);
  if (!validChat(record?.owner)) return;
  const queue = noticeDirectory(record.bound ? dir : null, record.owner);
  writeAtomic(path.join(queue, id), { dir });
  // A prompt may already have claimed the retry file as soon as the pointer appeared.
  renameSync(file, path.join(dir, `watch-sleep.${id}.ready`));
}

/** Another prompt or the watcher can move a pending file between directory listing and read. */
function readPending(file) {
  try { return regularJson(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Persist a fingerprint of the claimant's process identity without storing its command line. */
function claimantIdentity(pid) {
  const identity = readProcessIdentity(pid, { env: { ...process.env, TZ: "UTC" } });
  return identity && createHash("sha256").update(identity).digest("hex");
}

/** A hook killed before its output settled leaves its receipt available to the next owner prompt. */
function abandonedClaims(dir, id) {
  const prefix = `watch-sleep.${id}.claim.`;
  return readdirSync(dir).filter(name => {
    if (!name.startsWith(prefix)) return false;
    const [pidText, identity] = name.slice(prefix.length).replace(/(?:\.(?:turn|at)-[\w-]+)?\.offered$/, "").split(".");
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 2) return false;
    if (identity) return processIdentityStatus(pid, identity, { identityOf: claimantIdentity }) === "dead";
    // A PID-only reservation can be recovered once that PID is gone.
    try { process.kill(pid, 0); } catch (error) { return error.code === "ESRCH"; }
    return false;
  });
}

/** A complete Codex turn can prove absence. An exact developer-context line proves delivery within that turn. */
function acceptedInTurn(file, turn, notice) {
  let active = false;
  let incomplete = false;
  for (const line of transcriptLines(file)) {
    if (!line || (!active && !line.includes(turn))) continue;
    let row;
    try { row = JSON.parse(line); } catch { if (active) return null; continue; }
    const item = row?.payload;
    if (row?.type === "event_msg" && ["task_started", "turn_started"].includes(item?.type)) {
      active = item.turn_id === turn;
    } else if (active && row?.type === "response_item" && item?.type === "message" && item.role === "developer") {
      const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
      for (const [index, part] of (item.content ?? []).entries()) {
        if (part?.type !== "input_text" || kinds?.[index] !== "hooks.additional_context") continue;
        const lines = part.text.split("\n");
        if (lines.includes(notice)) return true;
        if (lines.some(text => text.startsWith("Full hook output saved to: "))) incomplete = true;
      }
    } else if (active && row?.type === "event_msg" && item?.turn_id === turn &&
        ["task_complete", "turn_complete", "turn_aborted"].includes(item.type)) {
      return incomplete ? null : false;
    }
  }
  return null;
}

/** A turnless host appends its prompt-hook attachments before the owning assistant finishes its response. */
function acceptedAfterPosition(file, position, chat, notice) {
  for (const line of transcriptLines(file, position)) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    if (row?.sessionId !== chat || row.isSidechain === true) continue;
    const hook = row.attachment;
    if (row.type === "attachment" && hook?.type === "hook_additional_context" && hook.hookEvent === "UserPromptSubmit" &&
        Array.isArray(hook.content) && hook.content.some(text => typeof text === "string" && text.split("\n").includes(notice))) return true;
    if (row.type === "assistant" && row.message?.role === "assistant" && row.message.stop_reason === "end_turn") return false;
  }
  return null;
}

/** Reserve the receipt atomically. Keep its pointer until the registered output writer settles. */
function claimNotice(pointer, id, chat, programDir, transcriptPath) {
  const match = NOTICE_ID.exec(id);
  if (!match || Number(match[2]) <= Number(match[1])) return null;
  const dir = readPending(pointer)?.dir;
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return null;
  const origins = [dir];
  if (programDir && canonicalHome(programDir) !== canonicalHome(dir)) origins.push(programDir);
  for (const origin of origins) {
    let stale;
    try { stale = abandonedClaims(origin, id); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const ready = `watch-sleep.${id}.ready`;
    for (const name of [`watch-sleep.${id}.retry`, ready, ...stale]) {
      const file = path.join(origin, name);
      const record = readPending(file);
      if (!record) continue;
      if (record.owner !== chat || !DISPLAY_TIME.test(record.slept) || !DISPLAY_TIME.test(record.woke)) return null;
      if ((record.bound || programDir) && (!programDir || canonicalHome(programDir) !== canonicalHome(origin))) return null;
      const context = `Heads up: this computer was asleep for ${duration(Number(match[2]) - Number(match[1]))} (slept ${record.slept}, woke ${record.woke}).`;
      if (name.endsWith(".offered")) {
        const mark = /\.(turn|at)-([\w-]+)\.offered$/.exec(name);
        if (!mark) continue;
        const accepted = mark[1] === "turn" ? acceptedInTurn(transcriptPath, mark[2], context)
          : acceptedAfterPosition(transcriptPath, mark[2], chat, context);
        if (accepted === null) continue;
        if (accepted) {
          try { unlinkSync(pointer); } catch {}
          unlinkSync(file);
          return null;
        }
      }
      const identity = claimantIdentity(process.pid);
      const claimant = identity ? `${process.pid}.${identity}` : process.pid;
      let claim = path.join(origin, `watch-sleep.${id}.claim.${claimant}`);
      try {
        renameSync(file, claim);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      return {
        context,
        offer(turn) {
          let tag = "";
          if (typeof turn === "string" && /^[\w-]{1,64}$/.test(turn)) tag = `.turn-${turn}`;
          else if (!turn) {
            const position = transcriptPosition(transcriptPath);
            if (position) tag = `.at-${position}`;
          }
          if (!tag) throw new Error("sleep notice has no recoverable transcript position");
          const offered = `${claim}${tag}.offered`;
          renameSync(claim, offered);
          claim = offered;
        },
        settle(delivered) {
          if (!delivered) return renameSync(claim, path.join(origin, ready));
          try { unlinkSync(pointer); } catch {}
          unlinkSync(claim);
        },
      };
    }
  }
  // Migration moves receipts before binding the chat. Keep the pointer until its matching receipt is claimed.
  return null;
}

/** Reserve this owner's confirmations. A prompt offers each independently before merging context. */
export function takeSleepNotices(dir, chat, isOrchestrator, event) {
  const queues = [noticeDirectory(null, chat)];
  if (dir) queues.push(noticeDirectory(dir, chat));
  const notices = [];
  for (const queue of queues) {
    let names;
    try {
      names = readdirSync(queue).filter(name => NOTICE_ID.test(name)).sort();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) continue;
      process.stderr.write(`watcher-sleep: ${error.message}\n`);
      continue;
    }
    if (names.length && !isOrchestrator()) return null;
    for (const id of names) {
      const pointer = path.join(queue, id);
      try {
        const notice = claimNotice(pointer, id, chat, dir, event?.transcript_path);
        if (!notice) continue;
        if (event) {
          try { notice.offer(event.turn_id); } catch (error) {
            notice.settle(false);
            throw error;
          }
        }
        notices.push(notice);
      } catch (error) {
        process.stderr.write(`watcher-sleep: ${error.message}\n`);
      }
    }
  }
  return notices.length ? {
    context: notices.map(notice => notice.context).join("\n"),
    settle(delivered) {
      for (const notice of notices) {
        try { notice.settle(delivered); } catch (error) { process.stderr.write(`watcher-sleep: ${error.message}\n`); }
      }
    },
  } : null;
}

if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "retry") {
    const [, dir, ...files] = args;
    retryNotices(dir, files);
  } else if (args[0] === "publish") {
    retryWindow(args[1], args[2], args[3]);
  } else {
    const [dir, start, end, platform, oldest, reported] = args;
    if (!/^\d{1,10}$/.test(start) || !/^\d{1,10}$/.test(end) || Number(end) <= Number(start)) {
      throw new Error("invalid watcher clock window");
    }
    await recordGap(dir, Number(start), Number(end), platform, oldest, reported);
  }
}
