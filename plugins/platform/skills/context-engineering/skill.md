---
name: context-engineering
description: This skill should be used when designing prompts, system prompts, or context windows for Claude. Triggers include writing prompts for API calls, designing agent instructions, structuring complex inputs, optimizing context for accuracy, using examples effectively, or implementing chain-of-thought reasoning. Provides comprehensive guidance from Anthropic's official prompt engineering documentation.
---

# Context Engineering

## Overview

Context engineering is the practice of designing the entire context window—system prompts, examples, structure, instructions, and data—to maximize Claude's performance. This skill distills Anthropic's official prompt engineering documentation into actionable guidance.

## When to Use

- Designing prompts for Claude API calls
- Writing system prompts for agents or assistants
- Structuring complex multi-part inputs
- Improving accuracy or consistency of outputs
- Adding examples to guide behavior
- Implementing reasoning patterns (chain of thought)

## Technique Priority

Apply techniques in order of effectiveness. Not all tasks require all techniques.

| Priority | Technique | Best For |
|----------|-----------|----------|
| 1 | Be clear and direct | All tasks |
| 2 | Use examples (multishot) | Format consistency, complex patterns |
| 3 | Chain of thought | Math, logic, analysis, complex reasoning |
| 4 | XML tags | Multi-part prompts, structured I/O |
| 5 | Role prompting | Domain expertise, tone adjustment |
| 6 | Prefill response | Output format control, character consistency |
| 7 | Chain prompts | Multi-step workflows, error isolation |
| 8 | Long context tips | Documents >20K tokens |
| 9 | Extended thinking | Complex STEM, constraint optimization |

## Core Techniques

### 1. Be Clear and Direct

Think of Claude as a brilliant new employee who needs explicit instructions.

**The Golden Rule:** Show the prompt to a colleague with minimal context. If they're confused, Claude will be too.

**Key Practices:**

- Provide contextual information (what results are for, target audience, workflow position, success criteria)
- Be specific about desired output (format, length, style)
- Use numbered steps for sequential instructions

<example>
<poor>
Please remove all personally identifiable information from these messages.
</poor>
<good>
Your task is to anonymize customer feedback for our quarterly review.

Instructions:
1. Replace customer names with "CUSTOMER_[ID]"
2. Replace emails with "EMAIL_[ID]@example.com"
3. Redact phone numbers as "PHONE_[ID]"
4. Leave product names intact
5. Output only processed messages, separated by "---"

Data to process: {{FEEDBACK_DATA}}
</good>
</example>

### 2. Use Examples (Multishot Prompting)

Examples dramatically improve accuracy, consistency, and quality.

**Best Practices:**

- Include 3-5 diverse, relevant examples
- Cover edge cases and potential challenges
- Wrap examples in `<example>` tags (nest within `<examples>` if multiple)
- Vary examples enough to avoid unintended pattern matching

<example>
<prompt>
Our CS team needs to categorize feedback. Use categories: UI/UX, Performance, Feature Request, Integration, Pricing, Other. Rate sentiment (Positive/Neutral/Negative) and priority (High/Medium/Low).

<example>
Input: The new dashboard is a mess! It takes forever to load, and I can't find the export button. Fix this ASAP!
Category: UI/UX, Performance
Sentiment: Negative
Priority: High
</example>

Now analyze: {{FEEDBACK}}
</prompt>
</example>

### 3. Chain of Thought (CoT)

Encourage Claude to break down problems step-by-step for complex reasoning tasks.

**When to Use:**
- Math and calculations
- Multi-step analysis
- Logic problems
- Decisions with many factors

**When to Avoid:**
- Simple factual questions (adds latency without benefit)

**Complexity Levels:**

| Level | Approach | Example |
|-------|----------|---------|
| Basic | "Think step-by-step" | Quick, less guided |
| Guided | Outline specific steps | More control over reasoning |
| Structured | Use `<thinking>` and `<answer>` tags | Easy to parse, separates reasoning from output |

<example>
<basic>
Solve this problem. Think step-by-step.
</basic>
<structured>
Draft personalized donor emails.

Program info: {{PROGRAM_DETAILS}}
Donor info: {{DONOR_DETAILS}}

Think before writing in <thinking> tags:
1. What messaging appeals to this donor given their history?
2. What program aspects match their interests?

Then write the email in <email> tags.
</structured>
</example>

### 4. XML Tags

Use XML tags to structure prompts with multiple components.

**Benefits:**
- **Clarity:** Separate instructions, examples, context, data
- **Accuracy:** Prevent Claude from mixing up components
- **Flexibility:** Easy to modify individual sections
- **Parseability:** Extract specific parts from outputs

**Best Practices:**
- Be consistent with tag names throughout prompts
- Nest tags for hierarchical content: `<outer><inner></inner></outer>`
- Reference tags in instructions: "Using the contract in `<contract>` tags..."
- Use meaningful names (`<instructions>`, `<context>`, `<examples>`, `<data>`)

<example>
<prompt>
Analyze this software licensing agreement for legal risks.

<context>
We're a multinational enterprise considering this for core infrastructure.
</context>

<agreement>
{{CONTRACT}}
</agreement>

<instructions>
1. Analyze: Indemnification, Limitation of liability, IP ownership
2. Note unusual or concerning terms
3. Compare to our standard: <standard_contract>{{STANDARD}}</standard_contract>
4. Summarize findings in <findings> tags
5. List recommendations in <recommendations> tags
</instructions>
</prompt>
</example>

See [references/xml-tags.md](references/xml-tags.md) for detailed patterns.

### 5. Role Prompting (System Prompts)

Use the `system` parameter to set Claude's role and dramatically improve domain performance.

**Benefits:**
- Enhanced accuracy in specialized domains
- Tailored communication style
- Improved focus on task requirements

**Best Practices:**
- Put role in `system` parameter, task in `user` turn
- Be specific: "data scientist specializing in customer insight for Fortune 500" vs "data scientist"
- Experiment with different roles for the same task

<example>
<basic>
system: "You are a helpful assistant."
</basic>
<enhanced>
system: "You are the General Counsel of a Fortune 500 tech company. You specialize in software licensing and data privacy regulations."
</enhanced>
</example>

### 6. Prefill Claude's Response

Guide outputs by prefilling the `Assistant` message.

**Use Cases:**
- Force specific output format (start with `{` for JSON)
- Skip preambles and explanations
- Maintain character in roleplay
- Ensure consistent structure

**Constraints:**
- Cannot end with trailing whitespace
- Not available with extended thinking mode

<example>
<json_output>
user: Extract name, price, color from: {{DESCRIPTION}}
assistant: {  <!-- prefill forces JSON output -->
</json_output>

<character_maintenance>
user: What do you deduce about this shoe?
assistant: [Sherlock Holmes]  <!-- prefill maintains character -->
</character_maintenance>
</example>

### 7. Chain Complex Prompts

Break complex tasks into sequential subtasks for better accuracy.

**When to Chain:**
- Multi-step analysis or synthesis
- Content creation pipelines
- Tasks requiring self-correction
- Complex transformations

**Benefits:**
- Each subtask gets full attention
- Easier to debug specific steps
- Can parallelize independent subtasks

**Patterns:**
- Research → Outline → Draft → Edit → Format
- Extract → Transform → Analyze → Visualize
- Generate → Review → Refine → Re-review (self-correction)

<example>
<chain>
Prompt 1: Analyze contract for risks → {{ANALYSIS}}
Prompt 2: Draft email based on <analysis>{{ANALYSIS}}</analysis>
Prompt 3: Review email for tone and clarity → {{FEEDBACK}}
Prompt 4: Revise email based on <feedback>{{FEEDBACK}}</feedback>
</chain>
</example>

### 8. Long Context Tips

For prompts with substantial data (20K+ tokens):

**Key Practices:**

1. **Put data at the top:** Place long documents above queries/instructions (up to 30% quality improvement)

2. **Structure with XML:** Wrap documents with metadata
```xml
<documents>
  <document index="1">
    <source>annual_report.pdf</source>
    <document_content>{{CONTENT}}</document_content>
  </document>
</documents>
```

3. **Ground in quotes:** Ask Claude to quote relevant sections before answering

See [references/long-context.md](references/long-context.md) for detailed patterns.

### 9. Extended Thinking

For complex problems requiring deep reasoning:

**Best Practices:**
- Start with minimum budget (1024 tokens), increase as needed
- Use general instructions first ("think thoroughly"), not prescriptive steps
- Ask Claude to verify work with test cases
- Use batch processing for >32K thinking tokens

**Best Use Cases:**
- Complex STEM problems
- Constraint optimization (multiple competing requirements)
- Problems requiring structured frameworks

See [references/extended-thinking.md](references/extended-thinking.md) for detailed patterns.

## Quick Reference

### Output Format Control

| Goal | Technique |
|------|-----------|
| JSON output | Prefill with `{` |
| Specific structure | Provide example in `<example>` tags |
| No preamble | Prefill or explicit instruction |
| Consistent format | Multishot examples |

### Improving Accuracy

| Problem | Solution |
|---------|----------|
| Misses instructions | Number steps, be explicit |
| Inconsistent format | Add examples |
| Wrong reasoning | Add CoT with structured output |
| Misses context | Add role prompting |
| Drops steps | Chain into separate prompts |

### Common Tag Names

| Tag | Purpose |
|-----|---------|
| `<instructions>` | Task directives |
| `<context>` | Background information |
| `<example>` / `<examples>` | Few-shot demonstrations |
| `<data>` / `<document>` | Input content |
| `<thinking>` | Chain of thought reasoning |
| `<answer>` / `<output>` | Final response |
| `<constraints>` | Limitations or requirements |

## Resources

For detailed guidance on specific techniques:

- [references/xml-tags.md](references/xml-tags.md) - Comprehensive XML structuring patterns
- [references/chain-of-thought.md](references/chain-of-thought.md) - CoT implementation details
- [references/long-context.md](references/long-context.md) - Working with large documents
- [references/extended-thinking.md](references/extended-thinking.md) - Extended thinking mode
