import { writeFileSync } from "node:fs";
import path from "node:path";
import { encodePng } from "../../../handoff/scripts/png-diff.mjs";

/** A synthetic current-head Web capture for readiness and publication guard fixtures. */
export function capturedFindings(directory, record, paths) {
  const png = "fixture-capture.png";
  writeFileSync(path.join(directory, png), encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }));
  const capture = { png, surface: "Web", target: "/", viewport: "390x800", theme: "light", paths,
    overflow: { width: 390, height: 800, checkedContainers: 1, entries: [] } };
  return { ...record, rounds: [{ id: "fixture-round", head: record.head, runtime: "web", captures: [capture] }] };
}
