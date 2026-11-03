import { describe, expect, it } from "vitest";
import { shortType, validateModel } from "./model.js";

describe("shortType", () => {
  it.each([
    ["character varying(255)", ["varchar(255)", false]],
    ["timestamp(3) without time zone", ["timestamp(3)", false]],
    ["timestamp with time zone", ["timestamptz", false]],
    ["double precision", ["float8", false]],
    ["public.user_role[]", ["user_role", true]],
    ['"Audit"."Kind"', ["Kind", false]],
    ["jsonb", ["jsonb", false]],
  ])("%s", (raw, expected) => {
    expect(shortType(raw)).toEqual(expected);
  });
});

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  column: name,
  type: "int",
  list: false,
  optional: false,
  kind: "scalar",
  pk: false,
  fk: false,
  uk: false,
  ...extra,
});

const model = (name: string, fields: unknown[]) => ({ name, table: name, doc: "", fields, ids: [], uniques: [], indexes: [] });

describe("validateModel", () => {
  it("accepts a well-formed model", () => {
    const m = {
      models: [model("a", [field("id")]), model("b", [field("a_id")])],
      enums: {},
      relations: [
        { child: "b", parent: "a", field: "a_id", fields: ["a_id"], references: ["id"], optional: false, oneToOne: false },
      ],
    };
    expect(validateModel(m)).toEqual([]);
  });

  it("reports each problem with where it is", () => {
    const m = {
      models: [
        model("a", [field("id"), field("kind", { kind: "enum", type: "nope" })]),
        model("a", [field("x", { list: "yes" })]),
        model("bad.name", []),
      ],
      relations: [
        { child: "a", parent: "a", field: "z", fields: ["z"], references: ["id"], optional: false, oneToOne: false },
        { child: "ghost", parent: "a", field: "z", fields: ["z"], references: ["id"], optional: false, oneToOne: false },
      ],
    };
    expect(validateModel(m)).toEqual([
      'models[0].fields[1]: enum type "nope" is not in enums',
      'models[1]: duplicate model name "a"',
      "models[1].fields[0].list must be a boolean",
      `models[2]: name "bad.name" must not contain '.', '/' or '#'`,
      'relations[0]: fields ["z"] must be columns of a',
      // The duplicate "a" (models[1], fields: [x]) is the one relations resolve against.
      'relations[0]: references ["id"] must be columns of a',
      "relations[1]: child and parent must both be model names",
    ]);
  });

  it("rejects a shape with no models", () => {
    expect(validateModel([])).toEqual(["top level must be an object with models, enums, relations"]);
    expect(validateModel({ models: [] })).toEqual(["models must be a non-empty list"]);
  });
});
