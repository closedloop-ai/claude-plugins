import { describe, expect, it } from "vitest";
import { missingMcpTools } from "./claude-preflight.js";
import { capabilityOperations } from "./contracts.js";
import { PROVIDER_BINDING } from "./test-fixtures.js";

// Read registrations from symphony-alpha e38ced1fbcd3eea403a4187940c52e58633cddee,
// apps/mcp/src/tool-registrations.ts. Keep the server spellings independent of the provider manifest.
const registeredNames = [
  "search",
  "list-projects",
  "get-project",
  "list-documents",
  "get-document",
  "get-document-content",
  "get-document-comments",
  "list-document-versions",
  "get-me",
  "list-users",
  "list-artifact-links",
];

describe("ISS-14476 ClosedLoop tracker reads", () => {
  it("AC-43 resolves every declared read grant against registered server tools", () => {
    const grants = [...capabilityOperations(PROVIDER_BINDING).read].map((name) => "mcp__closedloop__" + name);
    const tools = registeredNames.map((name) => "mcp__closedloop__" + name);

    expect(grants).toContain("mcp__closedloop__list_document_versions");
    expect(grants).toContain("mcp__closedloop__list_artifact_links");
    expect(missingMcpTools(tools, grants)).toEqual([]);
    expect(missingMcpTools(tools.filter((tool) => tool !== "mcp__closedloop__get-me"), grants))
      .toEqual(["mcp__closedloop__get_me"]);
  });
});
