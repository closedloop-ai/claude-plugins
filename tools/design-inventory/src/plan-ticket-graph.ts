/**
 * Plan the ticket dependency graph for a set of design-inventory findings (PLN-859 P4b).
 *
 * Grouping policy:
 * - One UI ticket per unit for EVERY unit type (screen, region, component, flow)
 *   that has at least one accepted non-backend-gap finding.
 *   Title templates by type:
 *     screen/region : "Implement <name> UI from approved design"
 *     component     : "Implement <name> component from approved design"
 *     flow          : "Implement <name> flow from approved design"
 * - One API ticket per unit only when it has accepted backend-gap findings. An
 *   API ticket stops at the SERVING layer: it assumes the data already exists
 *   upstream and only needs an endpoint.
 * - One DATA ticket per unit, additionally, when any accepted backend-gap finding
 *   has `data_flow.gap_layer` of "capture" or "ingestion" -- i.e. the data is not
 *   produced/captured at its source or not synced into the platform DB today.
 *   Nobody tickets where the data comes from otherwise, so the API ticket alone
 *   would be wrong. The data ticket covers capturing and syncing that data.
 * - Shared net-new components build once in their PRIMARY unit's UI ticket;
 *   consumer units reference it via `uses`. The primary is the first unit in
 *   manifest order that needs the component (any unit type).
 * - Edge policy: the pipeline layers (data capture/ingestion -> api/serving -> ui)
 *   are PARALLELIZABLE, not hard-sequenced. The api and ui can be built against the
 *   contract and render empty / no-data states until the upstream data lands, and
 *   the data model often lives inside the serving ticket, so a hard "data BLOCKS
 *   api" edge over-constrains the adjacency and is directionally ambiguous. So the
 *   pipeline-adjacency edges (data -> api and api -> ui) are RELATES_TO edges,
 *   emitted in the `relates` array. BLOCKS is reserved ONLY for a genuine
 *   build-time prerequisite: a net-new shared component built in its PRIMARY unit's
 *   UI ticket literally cannot be imported until it exists, so the primary UI
 *   ticket BLOCKS every consumer UI ticket (never self); those are the `blocks`
 *   array.
 *
 * Usage:
 *     node plan-ticket-graph.mjs --findings <dir-or-files...> \
 *         --decisions <decisions.json> --manifest <manifest.json> \
 *         --out <ticket-plan.json>
 *
 * Exit codes: 0 ok, 1 input/validation error.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  effectiveDecision,
  validateDecisions,
  validateFindings,
  type JsonObject,
} from "./design-findings-schema.js";
import { checkThemeIdUniqueness } from "./theme-id-guard.js";
import { runWhenMain } from "./cli.js";

const ACCEPTED_STATES = new Set(["accepted", "edited"]);

/** Derive the UI ticket title for a unit based on its type. */
function uiTicketTitle(unitName: string, unitType: string): string {
  if (unitType === "component") return `Implement ${unitName} component from approved design`;
  if (unitType === "flow") return `Implement ${unitName} flow from approved design`;
  return `Implement ${unitName} UI from approved design`;
}

/** Derive the data-source ticket title for a unit. */
function dataTicketTitle(unitName: string): string {
  return `Capture and sync data for ${unitName}`;
}

/** Gap layers that require a separate upstream data-source ticket. */
const DATA_SOURCE_LAYERS = new Set(["capture", "ingestion"]);

/** True when a backend-gap finding's data_flow sits at the capture/ingestion layer. */
function needsDataTicket(finding: JsonObject): boolean {
  const dataFlow = finding["data_flow"] as JsonObject | null | undefined;
  return !!dataFlow && DATA_SOURCE_LAYERS.has(String(dataFlow["gap_layer"]));
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Collect findings JSON file paths from a mix of files and directories. */
function collectFindingsPaths(inputs: string[]): string[] {
  const paths: string[] = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      throw new Error(`findings path not found: ${input}`);
    }
    const st = statSync(input);
    if (st.isDirectory()) {
      for (const entry of readdirSync(input).sort()) {
        if (entry.endsWith(".json")) {
          paths.push(join(input, entry));
        }
      }
    } else {
      paths.push(input);
    }
  }
  return paths;
}

export interface UiTicket {
  id: string;
  kind: "ui";
  unit_id: string;
  title: string;
  criteria: string[];
  builds?: string[];
  uses?: Array<{ component: string; built_by: string }>;
}

export interface ApiTicket {
  id: string;
  kind: "api";
  unit_id: string;
  title: string;
  criteria: string[];
}

export interface DataTicket {
  id: string;
  kind: "data";
  unit_id: string;
  title: string;
  criteria: string[];
}

export type Ticket = UiTicket | ApiTicket | DataTicket;

export interface Edge {
  from: string;
  to: string;
  reason: string;
}

export interface TicketPlan {
  schema_version: 1;
  tickets: Ticket[];
  /** BLOCKS edges: genuine build-time prerequisites (shared-component primary -> consumer UI). */
  blocks: Edge[];
  /** RELATES_TO edges: parallelizable pipeline adjacencies (data -> api, api -> ui). */
  relates: Edge[];
}

export function buildTicketGraph(
  findingsDocs: JsonObject[],
  decisions: Record<string, JsonObject>,
  manifestUnitIds: string[],
): TicketPlan {
  // Index docs by unit id
  const docByUnitId = new Map<string, JsonObject>();
  for (const doc of findingsDocs) {
    const unit = doc["unit"] as JsonObject;
    docByUnitId.set(String(unit["id"]), doc);
  }

  // Determine manifest order: only units present in our docs
  const orderedUnitIds: string[] = [];
  for (const uid of manifestUnitIds) {
    if (docByUnitId.has(uid)) {
      orderedUnitIds.push(uid);
    }
  }
  // Append any docs not in manifest (preserve relative order via findingsDocs order)
  const inManifest = new Set(orderedUnitIds);
  for (const doc of findingsDocs) {
    const uid = String((doc["unit"] as JsonObject)["id"]);
    if (!inManifest.has(uid)) {
      orderedUnitIds.push(uid);
    }
  }

  // For each unit, determine accepted findings split by category
  interface UnitInfo {
    unitId: string;
    unitName: string;
    unitType: string;
    doc: JsonObject;
    acceptedNonBackend: JsonObject[];
    acceptedBackend: JsonObject[];
    allAccepted: JsonObject[];
    // net-new component proposed names from accepted findings
    newComponentNames: string[];
  }

  const unitInfos: UnitInfo[] = [];

  for (const unitId of orderedUnitIds) {
    const doc = docByUnitId.get(unitId);
    if (!doc) continue;
    const unit = doc["unit"] as JsonObject;
    const unitType = String(unit["type"]);

    const findingsArr = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
    const allAccepted = findingsArr.filter((f) =>
      ACCEPTED_STATES.has(effectiveDecision(f, decisions)),
    );

    if (allAccepted.length === 0) continue;

    const acceptedNonBackend = allAccepted.filter((f) => f["category"] !== "backend-gap");
    const acceptedBackend = allAccepted.filter((f) => f["category"] === "backend-gap");

    // Collect net-new component names from accepted findings' reuse blocks
    const newComponentNames: string[] = [];
    for (const finding of allAccepted) {
      const reuse = finding["reuse"] as JsonObject | null | undefined;
      if (reuse && reuse["resolution"] === "new-component" && reuse["proposed_name"]) {
        const name = String(reuse["proposed_name"]);
        if (!newComponentNames.includes(name)) {
          newComponentNames.push(name);
        }
      }
    }
    // Also include unit-level component_reuse table entries with new-component,
    // but only when the unit has at least one accepted finding (already filtered here)
    const reuseTable = Array.isArray(doc["component_reuse"])
      ? (doc["component_reuse"] as JsonObject[])
      : [];
    for (const entry of reuseTable) {
      if (entry["resolution"] === "new-component" && entry["proposed_name"]) {
        const name = String(entry["proposed_name"]);
        if (!newComponentNames.includes(name)) {
          newComponentNames.push(name);
        }
      }
    }

    unitInfos.push({
      unitId,
      unitName: String(unit["name"]),
      unitType,
      doc,
      acceptedNonBackend,
      acceptedBackend,
      allAccepted,
      newComponentNames,
    });
  }

  // Determine PRIMARY unit for each net-new component (first in manifest order that needs it).
  // Any unit type can be the primary builder.
  // Map: componentName -> primaryUnitId
  const componentPrimaryUnit = new Map<string, string>();
  for (const info of unitInfos) {
    for (const name of info.newComponentNames) {
      if (!componentPrimaryUnit.has(name)) {
        componentPrimaryUnit.set(name, info.unitId);
      }
    }
  }

  const tickets: Ticket[] = [];
  const blocks: Edge[] = [];
  const relates: Edge[] = [];
  const addedBlocks = new Set<string>();
  const addedRelates = new Set<string>();

  // BLOCKS edge: a genuine build-time prerequisite. Deduped, never self.
  function addBlock(from: string, to: string, reason: string): void {
    if (from === to) return;
    const key = `${from}|${to}`;
    if (!addedBlocks.has(key)) {
      addedBlocks.add(key);
      blocks.push({ from, to, reason });
    }
  }

  // RELATES_TO edge: a parallelizable pipeline adjacency. Deduped, never self.
  function addRelate(from: string, to: string, reason: string): void {
    if (from === to) return;
    const key = `${from}|${to}`;
    if (!addedRelates.has(key)) {
      addedRelates.add(key);
      relates.push({ from, to, reason });
    }
  }

  // Track UI ticket id per unit for edge construction
  const uiTicketIdByUnit = new Map<string, string>();

  for (const info of unitInfos) {
    const uiId = `ui:${info.unitId}`;
    const apiId = `api:${info.unitId}`;
    const dataId = `data:${info.unitId}`;

    // UI ticket (all unit types)
    if (info.acceptedNonBackend.length > 0) {
      const criteria = info.acceptedNonBackend.map((f) => String(f["id"]));

      // Determine builds and uses for this unit
      const builds: string[] = [];
      const uses: Array<{ component: string; built_by: string }> = [];

      for (const name of info.newComponentNames) {
        const primary = componentPrimaryUnit.get(name);
        if (primary === info.unitId) {
          builds.push(name);
        } else if (primary !== undefined) {
          uses.push({ component: name, built_by: `ui:${primary}` });
        }
      }

      const uiTicket: UiTicket = {
        id: uiId,
        kind: "ui",
        unit_id: info.unitId,
        title: uiTicketTitle(info.unitName, info.unitType),
        criteria,
      };
      if (builds.length > 0) uiTicket.builds = builds;
      if (uses.length > 0) uiTicket.uses = uses;

      tickets.push(uiTicket);
      uiTicketIdByUnit.set(info.unitId, uiId);
    }

    // API ticket
    if (info.acceptedBackend.length > 0) {
      const apiTicket: ApiTicket = {
        id: apiId,
        kind: "api",
        unit_id: info.unitId,
        title: `Backend for ${info.unitName}`,
        criteria: info.acceptedBackend.map((f) => String(f["id"])),
      };
      tickets.push(apiTicket);

      // API ticket RELATES_TO the UI ticket: the layers build in parallel and the
      // UI renders empty states until the api lands; this is not a hard block.
      if (uiTicketIdByUnit.has(info.unitId)) {
        addRelate(
          apiId,
          uiTicketIdByUnit.get(info.unitId)!,
          "api and ui build in parallel against the contract; ui renders empty states until the api lands",
        );
      }

      // Data-source ticket: emitted only when an accepted backend-gap finding is
      // at the capture/ingestion layer (the data is not produced/synced today).
      // It covers capturing and syncing that data and RELATES_TO the API ticket.
      const captureIngestion = info.acceptedBackend.filter(needsDataTicket);
      if (captureIngestion.length > 0) {
        const dataTicket: DataTicket = {
          id: dataId,
          kind: "data",
          unit_id: info.unitId,
          title: dataTicketTitle(info.unitName),
          criteria: captureIngestion.map((f) => String(f["id"])),
        };
        tickets.push(dataTicket);

        // Data ticket RELATES_TO the API ticket: the layers build in parallel and
        // the api serves empty / no-data responses until the data lands; the data
        // model often lives inside the serving ticket, so this is not a hard block.
        addRelate(
          dataId,
          apiId,
          "data and api build in parallel; the api serves empty states until the data is captured and synced",
        );
      }
    }
  }

  // Primary UI tickets block consumer UI tickets
  for (const info of unitInfos) {
    const primaryUiId = uiTicketIdByUnit.get(info.unitId);
    if (!primaryUiId) continue;

    for (const name of info.newComponentNames) {
      const primary = componentPrimaryUnit.get(name);
      if (primary !== info.unitId) continue;

      // This unit is the primary builder; find all consumers (any unit type)
      for (const consumer of unitInfos) {
        if (consumer.unitId === info.unitId) continue;
        if (!consumer.newComponentNames.includes(name)) continue;
        const consumerUiId = uiTicketIdByUnit.get(consumer.unitId);
        if (consumerUiId) {
          addBlock(
            primaryUiId,
            consumerUiId,
            `builds ${name} needed by ${consumer.unitId}`,
          );
        }
      }
    }
  }

  return { schema_version: 1, tickets, blocks, relates };
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      findings: { type: "string", multiple: true },
      decisions: { type: "string" },
      manifest: { type: "string" },
      out: { type: "string" },
    },
  });

  const findingsInputs = values["findings"] ?? [];
  const decisionsPath = values["decisions"];
  const manifestPath = values["manifest"];
  const outPath = values["out"];

  // Also accept positional args as additional findings
  const allFindingsInputs = [...findingsInputs, ...positionals];

  if (allFindingsInputs.length === 0 || !decisionsPath || !manifestPath || !outPath) {
    console.error(
      "error: --findings <dir-or-files...>, --decisions, --manifest, and --out are required",
    );
    return 1;
  }

  // Load findings files
  let findingsPaths: string[];
  try {
    findingsPaths = collectFindingsPaths(allFindingsInputs);
  } catch (exc) {
    console.error(`error: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }

  if (findingsPaths.length === 0) {
    console.error("error: no findings JSON files found");
    return 1;
  }

  // Load and validate findings docs
  const findingsDocs: JsonObject[] = [];
  for (const p of findingsPaths) {
    let doc: unknown;
    try {
      doc = loadJson(p);
    } catch (exc) {
      console.error(`error loading ${p}: ${exc instanceof Error ? exc.message : String(exc)}`);
      return 1;
    }
    const errors = validateFindings(doc);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`${p}: ${err}`);
      }
      return 1;
    }
    findingsDocs.push(doc as JsonObject);
  }

  // Guard against cross-unit theme id collisions before planning
  const themeGuardResult = checkThemeIdUniqueness(findingsDocs);
  if (themeGuardResult !== 0) return themeGuardResult;

  // Load and validate decisions
  let decisionsDoc: unknown;
  try {
    decisionsDoc = loadJson(decisionsPath);
  } catch (exc) {
    console.error(`error loading ${decisionsPath}: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
  const decisionsErrors = validateDecisions(decisionsDoc);
  if (decisionsErrors.length > 0) {
    for (const err of decisionsErrors) {
      console.error(`${decisionsPath}: ${err}`);
    }
    return 1;
  }
  const decisions = (decisionsDoc as JsonObject)["decisions"] as Record<string, JsonObject>;

  // Load manifest (expected to be a JSON object with a "units" array of {id: string, ...})
  let manifest: unknown;
  try {
    manifest = loadJson(manifestPath);
  } catch (exc) {
    console.error(`error loading ${manifestPath}: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }

  // Extract unit order from manifest
  let manifestUnitIds: string[] = [];
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    !Array.isArray(manifest) &&
    Array.isArray((manifest as JsonObject)["units"])
  ) {
    manifestUnitIds = ((manifest as JsonObject)["units"] as JsonObject[])
      .filter((u) => typeof u["id"] === "string")
      .map((u) => String(u["id"]));
  } else if (Array.isArray(manifest)) {
    // Support plain array of unit objects
    manifestUnitIds = (manifest as JsonObject[])
      .filter((u) => typeof u["id"] === "string")
      .map((u) => String(u["id"]));
  }

  const plan = buildTicketGraph(findingsDocs, decisions, manifestUnitIds);

  writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf-8");

  const uiCount = plan.tickets.filter((t) => t.kind === "ui").length;
  const apiCount = plan.tickets.filter((t) => t.kind === "api").length;
  const dataCount = plan.tickets.filter((t) => t.kind === "data").length;
  const blockCount = plan.blocks.length;
  const relateCount = plan.relates.length;
  console.log(
    `${outPath} -- ui=${uiCount} api=${apiCount} data=${dataCount} blocks=${blockCount} relates=${relateCount}`,
  );
  return 0;
}

runWhenMain(import.meta.url, main);
