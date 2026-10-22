// Reads a pull request's review threads through `gh api graphql`, for the
// fleet board (unresolved human threads on a slow writer) and the writer's
// shepherd (an unresolved thread waiting on the writer is round-one work or
// a later-round thread to triage).

import { execFileSync } from "node:child_process";

const QUERY = "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} createdAt}} latest:comments(last:1){nodes{author{login}}}}}}}}";

/** Each thread as `{ resolved, opener, lastAuthor, createdAt }`, or null when gh cannot answer. */
export function readThreads(repo, pr, gh = "gh") {
  const [owner, name] = repo.split("/");
  try {
    const out = execFileSync(gh, ["api", "graphql", "-f", `query=${QUERY}`, "-F", `o=${owner}`, "-F", `n=${name}`, "-F", `p=${pr}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes.map((node) => ({
      resolved: node?.isResolved === true,
      opener: node?.comments?.nodes?.[0]?.author?.login ?? null,
      lastAuthor: node?.latest?.nodes?.[0]?.author?.login ?? node?.comments?.nodes?.[0]?.author?.login ?? null,
      createdAt: node?.comments?.nodes?.[0]?.createdAt ?? null,
    }));
  } catch {
    return null;
  }
}
