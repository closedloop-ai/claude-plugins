// Splits a Bash command line into its simple commands for the PreToolUse
// guards: each segment's leading NAME=value assignments and its words, with
// wrappers (sudo, env, exec and the like) removed so words[0] is the program.

import path from "node:path";

const SEPARATOR = /\|\||&&|[;|&\n]|\$\(|`|\(|\)/;
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "builtin", "env"]);

/** `{ env, words }` for each simple command in `command`. */
export function commandSegments(command) {
  return command.split(SEPARATOR).map((segment) => {
    const words = segment.trim().split(/\s+/).filter((word) => word && !/[<>]/.test(word)).map((word) => word.replace(/^["']|["']$/g, ""));
    const env = {};
    while (words.length > 0) {
      const assignment = ENV_ASSIGN.exec(words[0]);
      if (assignment) env[assignment[1]] = assignment[2];
      else if (!WRAPPERS.has(path.basename(words[0]))) break;
      words.shift();
    }
    return { env, words };
  });
}
