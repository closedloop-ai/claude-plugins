/**
 * Shared schema for the design-inventory pipeline (FEA-1739 / PLN-859).
 *
 * Defines the wire format produced by design-unit-analyst agents
 * (findings.json, one document per design unit) and by the review step
 * (decisions.json), plus dependency-free validators. Every downstream stage --
 * report rendering, the HTML review page, design packs, and ticket bodies --
 * consumes these documents instead of re-parsing analyst prose.
 *
 * This module is the schema/library module: tool scripts in this directory
 * import constants and validators from it; it must not call into any tool
 * script.
 *
 * Layering note on `recommendation`:
 *   The `recommendation` field on each finding is OPTIONAL in this schema for
 *   backward compatibility with findings artifacts written before the field was
 *   introduced, and to allow renderers to degrade gracefully when it is absent.
 *   However, by the agent contract (design-unit-analyst), `recommendation` is
 *   REQUIRED on every finding the analyst emits: analysts must include
 *   `{ action: "accept"|"decline"|"discuss", rationale: string }` for every
 *   finding before validating. Renderers that encounter a finding without a
 *   `recommendation` derive a fallback action from the finding's `intent`
 *   field (likely-intentional -> accept, likely-unintentional -> decline,
 *   unclear -> discuss).
 */

export const SCHEMA_VERSION = 1;

export const UNIT_TYPES = ["screen", "region", "component", "flow"] as const;
export const CLASSIFICATIONS = [
  "existing-unchanged",
  "existing-modified",
  "new",
  "deprecated-do-not-implement",
] as const;
export const FINDING_CATEGORIES = [
  "visual",
  "behavioral",
  "component-divergence",
  "backend-gap",
  "token-drift",
] as const;
/**
 * Pipeline layers a backend-gap can sit at, deepest-missing first.
 *   capture   - the raw data is not produced/captured at its source today.
 *   ingestion - the data is produced but no sync/ingestion path lands it in the platform DB.
 *   model     - the data lands somewhere but the storage/domain model does not hold it.
 *   serving   - the data exists in the platform DB but no API/endpoint serves it to the UI.
 *   unknown   - the provenance could not be traced.
 * A capture- or ingestion-layer gap means nobody tickets where the data comes
 * from; it becomes a separate data-source ticket that blocks the serving/API ticket.
 */
export const GAP_LAYERS = ["capture", "ingestion", "model", "serving", "unknown"] as const;
export const INTENTS = ["likely-intentional", "likely-unintentional", "unclear"] as const;
export const DECISION_STATES = ["pending", "accepted", "declined", "edited"] as const;
export const REVIEW_STATES = ["accepted", "declined", "edited"] as const;
export const REUSE_RESOLUTIONS = ["reuse", "new-component", "not-applicable"] as const;
export const IMPL_STATUSES = ["found", "not_found"] as const;
export const RECOMMENDATION_ACTIONS = ["accept", "decline", "discuss"] as const;

export const FINDING_ID = /^CHG-[a-z0-9][a-z0-9-]*-\d{2,}$/;
export const THEME_ID = /^thm-[a-z0-9][a-z0-9-]*$/;
export const UNIT_ID = /^(?:scr|rgn|cmp|flw)-[a-z0-9][a-z0-9-]*$/;

export const UNIT_ID_PREFIX: Record<string, string> = {
  screen: "scr",
  region: "rgn",
  component: "cmp",
  flow: "flw",
};

export type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function checkRefsBlock(block: unknown, label: string, errors: string[]): void {
  if (!isObject(block)) {
    errors.push(`${label} must be an object with summary/refs`);
    return;
  }
  if (!isNonEmptyString(block["summary"])) {
    errors.push(`${label}.summary must be a non-empty string`);
  }
  if (!isStringArray(block["refs"] ?? [])) {
    errors.push(`${label}.refs must be a list of strings`);
  }
  const selectors = block["selectors"];
  if (selectors !== null && selectors !== undefined && !isStringArray(selectors)) {
    errors.push(`${label}.selectors must be a list of CSS selector strings when present`);
  }
}

function checkScreenshot(value: unknown, label: string, errors: string[]): void {
  if (value !== null && value !== undefined && !isNonEmptyString(value)) {
    errors.push(`${label}.screenshot must be a non-empty string path when present`);
  }
}

function checkReuse(reuse: unknown, label: string, errors: string[]): void {
  if (reuse === null || reuse === undefined) return;
  if (!isObject(reuse)) {
    errors.push(`${label} must be an object or null`);
    return;
  }
  const resolution = reuse["resolution"];
  if (!oneOf(resolution, REUSE_RESOLUTIONS)) {
    errors.push(`${label}.resolution must be one of ${REUSE_RESOLUTIONS.join(", ")}`);
    return;
  }
  if (resolution === "reuse") {
    for (const key of ["component", "import_path"]) {
      if (!isNonEmptyString(reuse[key])) {
        errors.push(`${label}.${key} required for resolution 'reuse'`);
      }
    }
  }
  if (resolution === "new-component" && !isNonEmptyString(reuse["proposed_name"])) {
    errors.push(`${label}.proposed_name required for resolution 'new-component'`);
  }
}

/**
 * Validate a finding's `data_flow` provenance block. On a `backend-gap` finding
 * this block is REQUIRED (`required: true`): it traces where the UI's missing
 * data is produced, captured, and synced today, so the planner can decide
 * whether a separate data-source ticket is needed. On any other category the
 * block is OPTIONAL, but when present it is still shape-checked so a stray
 * `data_flow` never carries a malformed value downstream.
 */
function checkDataFlow(dataFlow: unknown, label: string, required: boolean, errors: string[]): void {
  if (dataFlow === null || dataFlow === undefined) {
    if (required) {
      errors.push(`${label}.data_flow is required for category 'backend-gap'`);
    }
    return;
  }
  if (!isObject(dataFlow)) {
    errors.push(`${label}.data_flow must be an object`);
    return;
  }
  if (!oneOf(dataFlow["gap_layer"], GAP_LAYERS)) {
    errors.push(`${label}.data_flow.gap_layer must be one of ${GAP_LAYERS.join(", ")}`);
  }
  if (!isNonEmptyString(dataFlow["origin"])) {
    errors.push(`${label}.data_flow.origin must be a non-empty string`);
  }
  if (typeof dataFlow["captured_today"] !== "boolean") {
    errors.push(`${label}.data_flow.captured_today must be a boolean`);
  }
  if (typeof dataFlow["ingested_today"] !== "boolean") {
    errors.push(`${label}.data_flow.ingested_today must be a boolean`);
  }
  if (!isStringArray(dataFlow["refs"] ?? [])) {
    errors.push(`${label}.data_flow.refs must be a list of strings when present`);
  }
}

/** Validate one per-unit findings document. Returns a list of errors. */
export function validateFindings(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(doc)) return ["findings document must be a JSON object"];
  if (doc["schema_version"] !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }

  const unit = isObject(doc["unit"]) ? doc["unit"] : {};
  if (!isObject(doc["unit"])) errors.push("unit must be an object");
  const unitId = unit["id"];
  if (typeof unitId !== "string" || !UNIT_ID.test(unitId)) {
    errors.push("unit.id must match scr-|rgn-|cmp-|flw- slug format");
  }
  if (!isNonEmptyString(unit["name"])) {
    errors.push("unit.name must be a non-empty string");
  }
  const unitType = unit["type"];
  if (!oneOf(unitType, UNIT_TYPES)) {
    errors.push(`unit.type must be one of ${UNIT_TYPES.join(", ")}`);
  } else if (typeof unitId === "string" && UNIT_ID.test(unitId)) {
    const prefix = UNIT_ID_PREFIX[unitType as string];
    if (prefix && !unitId.startsWith(`${prefix}-`)) {
      errors.push(`unit.id prefix must be '${prefix}-' for type '${String(unitType)}'`);
    }
  }
  if (!oneOf(unit["classification"], CLASSIFICATIONS)) {
    errors.push(`unit.classification must be one of ${CLASSIFICATIONS.join(", ")}`);
  }
  const sources = isStringArray(unit["design_sources"]) ? unit["design_sources"] : [];
  if (!isStringArray(unit["design_sources"]) || sources.length === 0) {
    errors.push("unit.design_sources must be a non-empty list of strings");
  }
  const primary = unit["primary_source"];
  if (typeof primary !== "string" || (sources.length > 0 && !sources.includes(primary))) {
    errors.push("unit.primary_source must be one of unit.design_sources");
  }
  const impl = unit["current_impl"];
  if (!isObject(impl) || !oneOf(impl["status"], IMPL_STATUSES)) {
    errors.push(`unit.current_impl.status must be one of ${IMPL_STATUSES.join(", ")}`);
  } else if (!isStringArray(impl["paths"] ?? [])) {
    errors.push("unit.current_impl.paths must be a list of strings");
  }
  const flag = unit["feature_flag"];
  if (flag !== null && flag !== undefined) {
    if (!isObject(flag) || typeof flag["required"] !== "boolean") {
      errors.push("unit.feature_flag.required must be a boolean when present");
    }
  }

  const themeIds = new Set<string>();
  const themes = doc["themes"] ?? [];
  if (!Array.isArray(themes)) {
    errors.push("themes must be a list");
  } else {
    themes.forEach((theme, i) => {
      if (!isObject(theme)) {
        errors.push(`themes[${i}] must be an object`);
        return;
      }
      const tid = theme["id"];
      if (typeof tid !== "string" || !THEME_ID.test(tid)) {
        errors.push(`themes[${i}].id must match thm- slug format`);
      } else if (themeIds.has(tid)) {
        errors.push(`duplicate theme id ${tid}`);
      } else {
        themeIds.add(tid);
      }
      if (!isNonEmptyString(theme["title"])) {
        errors.push(`themes[${i}].title must be a non-empty string`);
      }
      checkScreenshot(theme["screenshot"], `themes[${i}]`, errors);
    });
  }

  const findings = doc["findings"];
  const seenIds = new Set<string>();
  if (!Array.isArray(findings)) {
    errors.push("findings must be a list");
  } else {
    findings.forEach((finding, i) => {
      const label = `findings[${i}]`;
      if (!isObject(finding)) {
        errors.push(`${label} must be an object`);
        return;
      }
      const fid = finding["id"];
      if (typeof fid !== "string" || !FINDING_ID.test(fid)) {
        errors.push(`${label}.id must match CHG-<unit>-<NN> format`);
      } else if (seenIds.has(fid)) {
        errors.push(`duplicate finding id ${fid}`);
      } else {
        seenIds.add(fid);
      }
      for (const key of ["title", "summary", "intent_rationale"]) {
        if (!isNonEmptyString(finding[key])) {
          errors.push(`${label}.${key} must be a non-empty string`);
        }
      }
      if (!oneOf(finding["category"], FINDING_CATEGORIES)) {
        errors.push(`${label}.category must be one of ${FINDING_CATEGORIES.join(", ")}`);
      }
      if (!oneOf(finding["intent"], INTENTS)) {
        errors.push(`${label}.intent must be one of ${INTENTS.join(", ")}`);
      }
      const themeRef = finding["theme"];
      if (themeRef !== null && themeRef !== undefined && !themeIds.has(themeRef as string)) {
        errors.push(`${label}.theme references unknown theme ${String(themeRef)}`);
      }
      checkRefsBlock(finding["state"], `${label}.state`, errors);
      checkRefsBlock(finding["spec"], `${label}.spec`, errors);
      checkScreenshot(finding["screenshot"], label, errors);
      checkReuse(finding["reuse"], `${label}.reuse`, errors);
      // data_flow provenance is required on backend-gap findings, shape-checked
      // (but optional) on every other category.
      checkDataFlow(finding["data_flow"], label, finding["category"] === "backend-gap", errors);
      const decision = finding["decision"] ?? { state: "pending" };
      if (!isObject(decision) || !oneOf(decision["state"], DECISION_STATES)) {
        errors.push(`${label}.decision.state must be one of ${DECISION_STATES.join(", ")}`);
      }
      const recommendation = finding["recommendation"];
      if (recommendation !== null && recommendation !== undefined) {
        if (!isObject(recommendation)) {
          errors.push(`${label}.recommendation must be an object`);
        } else {
          if (!oneOf(recommendation["action"], RECOMMENDATION_ACTIONS)) {
            errors.push(
              `${label}.recommendation.action must be one of ${RECOMMENDATION_ACTIONS.join(", ")}`,
            );
          }
          if (!isNonEmptyString(recommendation["rationale"])) {
            errors.push(`${label}.recommendation.rationale must be a non-empty string`);
          }
        }
      }
    });
  }

  const reuseTable = doc["component_reuse"] ?? [];
  if (!Array.isArray(reuseTable)) {
    errors.push("component_reuse must be a list");
  } else {
    reuseTable.forEach((entry, i) => {
      const label = `component_reuse[${i}]`;
      if (!isObject(entry)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (!isNonEmptyString(entry["element"])) {
        errors.push(`${label}.element must be a non-empty string`);
      }
      checkReuse(entry, label, errors);
    });
  }

  const visualSpec = doc["visual_spec"];
  if (visualSpec !== null && visualSpec !== undefined && !isObject(visualSpec)) {
    errors.push("visual_spec must be an object or null");
  }

  return errors;
}

/** Validate a decisions.json document. Returns a list of errors. */
export function validateDecisions(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(doc)) return ["decisions document must be a JSON object"];
  if (doc["schema_version"] !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(doc["reviewer"])) {
    errors.push("reviewer must be a non-empty string");
  }
  if (!isNonEmptyString(doc["decided_at"])) {
    errors.push("decided_at must be a non-empty string (ISO timestamp)");
  }
  const decisions = doc["decisions"];
  if (!isObject(decisions)) {
    errors.push("decisions must be an object keyed by finding/theme id");
    return errors;
  }
  for (const [key, value] of Object.entries(decisions)) {
    if (!FINDING_ID.test(key) && !THEME_ID.test(key)) {
      errors.push(`decision key ${key} is neither a CHG- finding id nor a thm- theme id`);
    }
    if (!isObject(value) || !oneOf(value["state"], REVIEW_STATES)) {
      errors.push(`decisions[${key}].state must be one of ${REVIEW_STATES.join(", ")}`);
    } else if (value["state"] === "edited" && !isNonEmptyString(value["edited_summary"])) {
      errors.push(`decisions[${key}].edited_summary required when state is 'edited'`);
    }
  }
  return errors;
}

/**
 * Resolve a finding's decision: explicit decision wins, then its theme's,
 * then the finding's embedded decision state, then 'pending'.
 */
export function effectiveDecision(
  finding: JsonObject,
  decisions: Record<string, JsonObject>,
): string {
  const fid = typeof finding["id"] === "string" ? finding["id"] : "";
  const explicit = decisions[fid];
  if (explicit) return String(explicit["state"]);
  const theme = finding["theme"];
  if (typeof theme === "string") {
    const themeDecision = decisions[theme];
    if (themeDecision) return String(themeDecision["state"]);
  }
  const embedded = finding["decision"];
  if (isObject(embedded) && typeof embedded["state"] === "string") {
    return embedded["state"];
  }
  return "pending";
}
