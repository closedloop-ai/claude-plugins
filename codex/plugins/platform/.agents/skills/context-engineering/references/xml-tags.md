# XML Tags Reference

Detailed guidance on using XML tags to structure prompts effectively.

## Why XML Tags Work

Claude's training included exposure to structured documents, making XML a natural way to organize information. Benefits:

- **Clarity:** Prevents Claude from mixing instructions with examples or context
- **Accuracy:** Reduces misinterpretation of prompt components
- **Flexibility:** Modify sections without rewriting entire prompts
- **Parseability:** Extract specific parts of Claude's response via post-processing

## Tag Naming

No canonical "best" tags exist—use names that make sense for your content:

| Good Tags | Use Case |
|-----------|----------|
| `<instructions>` | Task directives |
| `<context>` | Background information |
| `<example>` / `<examples>` | Demonstrations |
| `<data>` / `<input>` | Content to process |
| `<document>` | Full documents with metadata |
| `<thinking>` | Chain of thought reasoning |
| `<answer>` / `<output>` | Final response |
| `<constraints>` | Limitations |
| `<format>` / `<formatting>` | Output structure specs |

## Best Practices

### 1. Be Consistent

Use the same tag names throughout prompts and reference them explicitly:

```
Using the contract in <contract> tags, identify risks...
```

### 2. Nest for Hierarchy

```xml
<documents>
  <document index="1">
    <source>report.pdf</source>
    <document_content>{{CONTENT}}</document_content>
  </document>
  <document index="2">
    <source>analysis.xlsx</source>
    <document_content>{{DATA}}</document_content>
  </document>
</documents>
```

### 3. Combine with Other Techniques

XML tags enhance other prompting techniques:

**With multishot prompting:**
```xml
<examples>
  <example>
    <input>Customer says: "This is broken!"</input>
    <output>Category: Bug Report, Sentiment: Negative</output>
  </example>
  <example>
    <input>Customer says: "Love the new feature!"</input>
    <output>Category: Feedback, Sentiment: Positive</output>
  </example>
</examples>
```

**With chain of thought:**
```xml
<instructions>
Think through the problem in <thinking> tags.
Provide your final answer in <answer> tags.
</instructions>
```

## Document Processing Pattern

For multi-document tasks:

```xml
<documents>
  <document index="1">
    <source>annual_report_2023.pdf</source>
    <document_content>
      {{ANNUAL_REPORT}}
    </document_content>
  </document>
  <document index="2">
    <source>competitor_analysis_q2.xlsx</source>
    <document_content>
      {{COMPETITOR_ANALYSIS}}
    </document_content>
  </document>
</documents>

<instructions>
Analyze the annual report and competitor analysis.
Identify strategic advantages and recommend Q3 focus areas.
</instructions>
```

## Output Structuring

Request structured output using XML:

```xml
<instructions>
1. Summarize findings in <findings> tags
2. List actionable recommendations in <recommendations> tags
3. Note any concerns in <concerns> tags
</instructions>
```

This makes post-processing straightforward:
- Parse `<findings>` for executive summary
- Extract `<recommendations>` for action items
- Flag `<concerns>` for review

## Common Patterns

### Task + Context + Data
```xml
<task>Summarize the key points</task>
<context>This is for a board presentation</context>
<data>{{CONTENT}}</data>
```

### Instructions + Examples + Input
```xml
<instructions>Classify the sentiment</instructions>
<examples>
  <example>...</example>
</examples>
<input>{{USER_TEXT}}</input>
```

### Role + Task + Constraints
```xml
<role>You are a financial analyst</role>
<task>Review this report</task>
<constraints>
- Focus on profitability metrics
- Keep analysis under 500 words
</constraints>
<report>{{REPORT}}</report>
```
