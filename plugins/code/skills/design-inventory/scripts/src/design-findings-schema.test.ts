import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  effectiveDecision,
  validateDecisions,
  validateFindings,
  type JsonObject,
} from "./design-findings-schema.js";
import { main as validateMain } from "./validate-findings.js";
import { validDecisions, validFindings } from "./test-fixtures.js";

type Mutator = (doc: JsonObject) => void;

const obj = (value: unknown): JsonObject => value as JsonObject;
const arr = (value: unknown): JsonObject[] => value as JsonObject[];

describe("validateFindings", () => {
  it("passes a valid document", () => {
    expect(validateFindings(validFindings())).toEqual([]);
  });

  const cases: Array<[string, Mutator, string]> = [
    ["schema version", (d) => (d.schema_version = 2), "schema_version"],
    ["unit id format", (d) => (obj(d.unit).id = "sessions-page"), "unit.id"],
    ["unit type", (d) => (obj(d.unit).type = "page"), "unit.type"],
    ["id prefix", (d) => (obj(d.unit).id = "cmp-sessions-page"), "prefix"],
    ["classification", (d) => (obj(d.unit).classification = "modified"), "classification"],
    ["primary source", (d) => (obj(d.unit).primary_source = "nope.jsx"), "primary_source"],
    [
      "impl status",
      (d) => (obj(obj(d.unit).current_impl).status = "maybe"),
      "current_impl.status",
    ],
    ["finding id", (d) => (arr(d.findings)[0]!.id = "CHG-1"), "format"],
    ["category", (d) => (arr(d.findings)[0]!.category = "layout"), "category"],
    ["intent", (d) => (arr(d.findings)[0]!.intent = "sure"), "intent"],
    ["unknown theme", (d) => (arr(d.findings)[0]!.theme = "thm-missing"), "unknown theme"],
    ["summary", (d) => (arr(d.findings)[0]!.summary = "  "), "summary"],
    [
      "decision state",
      (d) => (obj(arr(d.findings)[0]!.decision).state = "maybe"),
      "decision.state",
    ],
    [
      "reuse import path",
      (d) => delete obj(arr(d.findings)[1]!.reuse).import_path,
      "import_path",
    ],
    [
      "new-component name",
      (d) => delete obj(arr(d.findings)[0]!.reuse).proposed_name,
      "proposed_name",
    ],
    ["reuse element", (d) => (arr(d.component_reuse)[0]!.element = ""), "element"],
  ];

  it.each(cases)("reports %s violations", (_name, mutate, fragment) => {
    const doc = validFindings();
    mutate(doc);
    const errors = validateFindings(doc);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes(fragment))).toBe(true);
  });

  it("rejects duplicate finding ids", () => {
    const doc = validFindings();
    arr(doc.findings)[1]!.id = arr(doc.findings)[0]!.id;
    expect(validateFindings(doc).some((e) => e.includes("duplicate finding id"))).toBe(true);
  });

  it("accepts optional selectors and screenshot fields", () => {
    const doc = validFindings();
    obj(arr(doc.findings)[0]!.spec).selectors = [".sess-topbar", ".sess-awaiting-chip"];
    arr(doc.findings)[0]!.screenshot = "shots/CHG-sessions-page-01.png";
    arr(doc.themes)[0]!.screenshot = "shots/thm-artifact-table.png";
    expect(validateFindings(doc)).toEqual([]);
  });

  it("rejects malformed selectors and screenshot fields", () => {
    const doc = validFindings();
    obj(arr(doc.findings)[0]!.spec).selectors = ".not-a-list";
    arr(doc.findings)[1]!.screenshot = "";
    arr(doc.themes)[0]!.screenshot = 7;
    const errors = validateFindings(doc);
    expect(errors.some((e) => e.includes("spec.selectors must be a list"))).toBe(true);
    expect(errors.some((e) => e.includes("findings[1].screenshot"))).toBe(true);
    expect(errors.some((e) => e.includes("themes[0].screenshot"))).toBe(true);
  });
});

describe("validateDecisions", () => {
  it("passes a valid document", () => {
    expect(validateDecisions(validDecisions())).toEqual([]);
  });

  it("rejects bad keys and states", () => {
    const doc = validDecisions();
    obj(doc.decisions).whatever = { state: "accepted" };
    obj(doc.decisions)["CHG-sessions-page-02"] = { state: "pending" };
    const errors = validateDecisions(doc);
    expect(errors.some((e) => e.includes("neither a CHG-"))).toBe(true);
    expect(errors.some((e) => e.includes("state must be one of"))).toBe(true);
  });

  it("requires edited_summary for edited", () => {
    const doc = validDecisions();
    obj(doc.decisions)["CHG-sessions-page-02"] = { state: "edited" };
    expect(validateDecisions(doc).some((e) => e.includes("edited_summary"))).toBe(true);
  });
});

describe("effectiveDecision", () => {
  it("explicit beats theme beats embedded", () => {
    const finding = arr(validFindings().findings)[0]!;
    const decisions = obj(validDecisions().decisions) as Record<string, JsonObject>;
    expect(effectiveDecision(finding, decisions)).toBe("accepted"); // via theme
    decisions[finding.id as string] = { state: "declined" };
    expect(effectiveDecision(finding, decisions)).toBe("declined"); // explicit wins
    expect(effectiveDecision(finding, {})).toBe("pending"); // embedded default
  });
});

describe("CLI", () => {
  it("handles ok, invalid, and garbage inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-"));
    const good = join(dir, "findings.json");
    writeFileSync(good, JSON.stringify(validFindings()));
    const decisions = join(dir, "decisions.json");
    writeFileSync(decisions, JSON.stringify(validDecisions()));
    expect(validateMain([good, decisions])).toBe(0);

    const badDoc = validFindings();
    obj(badDoc.unit).type = "page";
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(badDoc));
    expect(validateMain([bad])).toBe(1);

    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "{not json");
    expect(validateMain([garbage])).toBe(2);
  });
});
