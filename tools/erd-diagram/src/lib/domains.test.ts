import { describe, expect, it } from "vitest";
import { draft, hubs, labelFor, merge, validateDomains, words } from "./domains.js";
import type { ErdModel, Relation, TableModel } from "./model.js";

function table(name: string): TableModel {
  return { name, table: name, doc: "", fields: [], ids: [], uniques: [], indexes: [] };
}

function rel(parent: string, child: string): Relation {
  return {
    child,
    parent,
    field: "x",
    fields: ["x"],
    references: ["id"],
    optional: false,
    oneToOne: false,
    name: null,
    onDelete: null,
  };
}

function modelOf(names: string[], edges: Array<[string, string]>): ErdModel {
  return { models: names.map(table), enums: {}, relations: edges.map(([p, c]) => rel(p, c)) };
}

/** 32 tables: an org hub everything points at, plus billing and agent clusters. */
function bigModel(): ErdModel {
  const billing = ["billing_account", "billing_invoice", "billing_line", "billing_payment", "billing_refund"];
  const agents = ["agent_run", "agent_step", "agent_tool_call", "agent_message", "agent_artifact"];
  const misc = Array.from({ length: 21 }, (_, i) => `misc_${String(i).padStart(2, "0")}`);
  const names = ["org", ...billing, ...agents, ...misc];
  const edges: Array<[string, string]> = names.filter((n) => n !== "org").map((n) => ["org", n]);
  edges.push(
    ["billing_account", "billing_invoice"],
    ["billing_invoice", "billing_line"],
    ["billing_invoice", "billing_payment"],
    ["billing_payment", "billing_refund"],
    ["agent_run", "agent_step"],
    ["agent_step", "agent_tool_call"],
    ["agent_run", "agent_message"],
    ["agent_run", "agent_artifact"],
  );
  return modelOf(names, edges);
}

describe("hubs", () => {
  it("finds tables referenced by at least max(10, 20%) distinct tables", () => {
    expect(hubs(bigModel())).toEqual(["org"]);
    expect(hubs(modelOf(["a", "b"], [["a", "b"]]))).toEqual([]);
  });
});

describe("words and labelFor", () => {
  it("splits snake_case, camelCase and schema-qualified names", () => {
    expect(words("billing_invoice_line")).toEqual(["billing", "invoice", "line"]);
    expect(words("AgentSessionTOOLCall")).toEqual(["Agent", "Session", "TOOL", "Call"]);
    expect(words("audit:LogEntry")).toEqual(["Log", "Entry"]);
  });

  it("labels a group by its longest shared prefix and avoids taken names", () => {
    expect(labelFor(["billing_invoice", "billing_line", "billing_payment"], new Set())).toBe("Billing");
    expect(labelFor(["AgentRun", "AgentRunStep", "AgentRunLog"], new Set())).toBe("AgentRun");
    expect(labelFor(["AgentRun", "AgentRunStep", "AgentRunLog"], new Set(["agentrun"]))).toBe("Agent");
  });
});

describe("draft", () => {
  it("uses one group for a small schema", () => {
    expect(draft(modelOf(["b", "a"], []))).toEqual([{ id: "all", name: "All tables", tables: ["a", "b"] }]);
  });

  it("puts every table in exactly one domain, with hubs in Core", () => {
    const model = bigModel();
    const domains = draft(model);
    expect(validateDomains(domains, model)).toEqual([]);
    expect(domains.flatMap((d) => d.tables).sort()).toEqual(model.models.map((m) => m.name).sort());
    expect(domains[0]).toEqual({ id: "core", name: "Core", tables: ["org"] });
    expect(domains.map((d) => d.name)).toEqual(expect.arrayContaining(["Billing", "Agent", "Misc"]));
  });
});

describe("merge", () => {
  it("keeps the map, drops removed tables and reports added ones", () => {
    const model = modelOf(["a", "b", "c"], []);
    const existing = [
      { id: "one", name: "One", tables: ["a", "gone"] },
      { id: "empty", name: "Empty", tables: ["gone_too"] },
      { id: "unsorted", name: "Unsorted", tables: ["b"] },
    ];
    expect(merge(existing, model)).toEqual({
      domains: [{ id: "one", name: "One", tables: ["a"] }],
      added: ["b", "c"],
      removed: ["gone", "gone_too"],
    });
  });
});

describe("validateDomains", () => {
  it("reports bad ids, unknown tables and duplicates", () => {
    const model = modelOf(["a", "b"], []);
    expect(
      validateDomains(
        [
          { id: "Bad Id", name: "x", tables: ["a"] },
          { id: "two", name: "y", tables: ["a", "zzz"] },
          { id: "two", name: "z", tables: [] },
        ],
        model,
      ),
    ).toEqual([
      'domains[0].id "Bad Id" must be lowercase letters, digits and dashes',
      '"a" is in both "Bad Id" and "two"',
      'domain "two" lists "zzz", which is not a table in the schema',
      'duplicate domain id "two"',
    ]);
    expect(validateDomains([], model)).toEqual(["domain map must be a non-empty list of {id, name, tables}"]);
  });
});
