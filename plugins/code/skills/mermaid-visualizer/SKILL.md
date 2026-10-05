---
name: mermaid-visualizer
description: This skill should be used when a user asks to explain a complex idea, concept, or system architecture, or when a diagram would be helpful to visualize control flows, system architectures, data flows, state machines, sequence diagrams, or entity relationships.
---

# Mermaid Visualizer

## Purpose

To create clear, effective Mermaid diagrams that visualize complex concepts, system architectures, and control flows. This skill provides comprehensive guidance for generating diagrams that aid understanding of intricate systems and processes.

## How to Use This Skill

1. **Understand the concept** being visualized by reviewing the user's description
2. **Select the appropriate diagram type** from the diagram type options below
3. **Reference the Mermaid syntax guide** in `references/mermaid-syntax.md` for correct syntax
4. **Create the diagram** using Mermaid markdown syntax
5. **Embed the diagram** in the response using markdown code fence with `mermaid` language identifier
6. **Follow best practices** from `references/mermaid-syntax.md` to ensure clarity and correctness

## Diagram Types Supported

- **Flowcharts**: Decision trees, process flows, control flows
- **Sequence Diagrams**: Interactions between components or systems over time
- **State Diagrams**: State transitions and triggers
- **Class Diagrams**: Object-oriented relationships and hierarchies
- **Entity Relationship Diagrams**: Database schemas and data relationships
- **System Architecture Diagrams**: Component relationships and service interactions

## Key Mermaid Concepts

**Node Syntax**: Use `NodeID[Label]` for rectangular nodes, `{Decision}` for diamonds, `(Rounded)` for rounded nodes.

**Edge Syntax**: Connect nodes with `-->` for arrows, `-.->` for dotted lines, and `|Label|` for edge descriptions.

**Prohibited Symbols**: Avoid unescaped quotes, pipes, brackets, colons, and semicolons in node IDs. Use underscores or hyphens for spaces in IDs, and quoted strings for complex labels.

For detailed syntax guidance, refer to `references/mermaid-syntax.md`.
