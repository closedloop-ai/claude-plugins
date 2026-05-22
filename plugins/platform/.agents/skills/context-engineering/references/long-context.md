# Long Context Reference

Guidance for working with Claude's extended context window (200K tokens).

## Core Principles

### 1. Put Long Data at the Top

Place documents and large inputs (~20K+ tokens) near the **top** of the prompt, above queries, instructions, and examples.

**Why:** Queries at the end can improve response quality by up to 30%, especially with complex multi-document inputs.

**Pattern:**
```
<documents>
{{LONG_CONTENT_HERE}}
</documents>

<instructions>
Your task based on the documents above...
</instructions>
```

### 2. Structure Documents with XML

Wrap each document with metadata for clarity:

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

Analyze the annual report and competitor analysis.
Identify strategic advantages and recommend Q3 focus areas.
```

### 3. Ground Responses in Quotes

For long document tasks, ask Claude to quote relevant sections before answering. This helps Claude cut through noise and focus on pertinent content.

**Example:**
```xml
<documents>
  <document index="1">
    <source>patient_symptoms.txt</source>
    <document_content>{{PATIENT_SYMPTOMS}}</document_content>
  </document>
  <document index="2">
    <source>patient_records.txt</source>
    <document_content>{{PATIENT_RECORDS}}</document_content>
  </document>
</documents>

<instructions>
1. Find quotes from the records relevant to diagnosing the symptoms
2. Place quotes in <quotes> tags
3. Based on quotes, list diagnostic information in <info> tags
</instructions>
```

## Document Indexing Pattern

For multiple documents, use consistent indexing:

```xml
<documents>
  <document index="1">
    <source>{{SOURCE_1}}</source>
    <metadata>
      <date>2023-06-15</date>
      <author>Finance Team</author>
      <type>quarterly_report</type>
    </metadata>
    <document_content>{{CONTENT_1}}</document_content>
  </document>
  <document index="2">
    <source>{{SOURCE_2}}</source>
    <metadata>
      <date>2023-09-01</date>
      <author>Strategy Team</author>
      <type>analysis</type>
    </metadata>
    <document_content>{{CONTENT_2}}</document_content>
  </document>
</documents>
```

## Citation Pattern

Request citations to source documents:

```
When referencing information, cite the source document by index.
Example: "Revenue increased 15% (Document 1)" or "Market share declined (Doc 2, p.4)"
```

## Chunking Strategy

For very large documents that exceed context limits:

1. **Summarize first:** Create summaries of each section
2. **Query with context:** Include relevant summaries + full text of most relevant sections
3. **Iterative refinement:** Use initial response to identify which sections need deeper analysis

## Performance Tips

| Scenario | Recommendation |
|----------|----------------|
| Single large doc | Put at top, query at bottom |
| Multiple docs | Index with XML, cite by index |
| Need specific facts | Request quotes first |
| Synthesis task | Provide clear output structure |
| Comparison task | Label documents clearly, request side-by-side analysis |

## Common Pitfalls

1. **Putting instructions before data:** Reduces accuracy
2. **Missing source attribution:** Claude may mix up which document said what
3. **Vague queries:** Be specific about what to extract
4. **No structure for multi-doc:** Without indexing, Claude struggles to reference specific documents
