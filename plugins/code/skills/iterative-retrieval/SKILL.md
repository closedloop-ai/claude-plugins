---
name: iterative-retrieval
description: Protocol for iteratively refining sub-agent queries through follow-up questions to ensure sufficient context
---

# Iterative Retrieval Skill

This skill enables orchestrators to iteratively refine sub-agent queries through follow-up questions, ensuring sub-agents gather sufficient context before the orchestrator accepts their output. This addresses the problem where orchestrators have semantic context that sub-agents lack, leading to incomplete summaries.

## Target Audience

This skill is designed for **the `/code` orchestrator only** (code.md slash command). Sub-agents do not use this skill - they simply respond to queries. The orchestrator is responsible for evaluating responses and deciding whether to resume with follow-ups.

**Note:** Sub-agents do NOT see this skill documentation in their context. Only the orchestrator can invoke and follow the protocol. Sub-agents are unaware they're part of an iterative retrieval loop - they just respond to queries and follow-ups as normal requests.

## Usage Model

This skill is **optional and opt-in**. Not every sub-agent call benefits from iterative refinement - simple lookups or well-defined queries don't need it. Invoke this skill when you anticipate that a sub-agent may return incomplete context due to semantic gaps.

## The 4-Phase Protocol

This protocol provides a structured approach to iterative context gathering. All 4 phases represent the **recommended workflow**, but **phases 2-4 are optional if the initial response is sufficient**. Exercise judgment - if Phase 2 evaluation shows context is sufficient on first pass, phases 3-4 aren't needed.

### Phase 1: Initial Dispatch

Define and dispatch the initial query with full context:

1. **Define PRIMARY OBJECTIVE**: Clearly state what you ultimately need to accomplish
2. **Formulate INITIAL QUERIES**: Specific questions or search criteria for the sub-agent
3. **Dispatch with BOTH**: Send both the queries AND the primary objective to provide semantic context
4. **Store AGENT ID**: Keep the `agent_id` returned from the `Task(...)` call for potential continuation via SendMessage

### Phase 2: Sufficiency Evaluation

Evaluate whether the sub-agent's response provides sufficient context using the checklist below. If context is sufficient, **skip to output** (phases 3-4 not needed). If gaps exist, proceed to Phase 3.

#### Sufficiency Evaluation Checklist

Ask yourself these 4 questions:

1. **Direct Answer**: Does the summary directly answer the orchestrator's primary objective?
2. **Obvious Gaps**: Are there obvious gaps the orchestrator could identify? (e.g., missing error handling, incomplete data flow, unaddressed edge cases)
3. **Adjacent Information**: Did the sub-agent mention adjacent or related information that wasn't fully explored?
4. **Confidence Check**: Would the orchestrator be confident proceeding with ONLY this information?

If you answer "no" to question 1 or 4, OR "yes" to questions 2 or 3, the context is likely insufficient - proceed to Phase 3.

### Phase 3: Refinement Request

Continue the sub-agent with targeted follow-up questions using SendMessage:

1. **Continue via SendMessage**: Use `SendMessage(to=<stored_agent_id>, summary=<5-10 word summary>, message=<prompt>)` to continue the subagent; completed subagents auto-resume from transcript in the background with full prior context intact
2. **Acknowledge what was useful**: Briefly confirm what information was valuable
3. **Specify EXACTLY what's needed**: Be precise about what additional context is required
4. **Ask about related info**: "Is there related information that might be relevant to [primary objective]?"

**Async flow:** SendMessage returns immediately with a queued acknowledgment. The subagent then runs in the background and you will receive a `<task-notification>` when it finishes. Do not proceed to the next step until that notification arrives.

**Fallback:** If no `agent_id` is in memory (cross-session resume after a previous Claude Code session ended) or SendMessage returns an actual error, fall back to a fresh `Task(...)` launch with a self-contained prompt that includes all prior context needed.

### Phase 4: Loop

Repeat Phases 2-3 until one of these conditions is met:

- **Context is sufficient**: All 4 checklist criteria are satisfied
- **Maximum cycles reached**: Recommended maximum of **3 refinement cycles** (see guidance below)
- **Source exhausted**: Sub-agent confirms no additional relevant information exists

## Refinement Cycle Guidance

The recommended maximum is **3 refinement cycles** (initial dispatch + 2 follow-ups). This balances thoroughness against cost and latency.

**Important**: This is a **recommendation, not an enforced limit**. As guidance documentation, this skill cannot enforce limits - the orchestrator has final judgment. However, exceeding 3 cycles often indicates:
- The query scope is too broad
- The sub-agent lacks access to needed information
- The primary objective should be broken into smaller queries

## Output Format

When iterative retrieval completes, report:

1. **Total refinement cycles used**: Number of iterations (including initial dispatch)
2. **What additional context was gathered**: Summarize what the follow-ups uncovered
3. **Agent ID for future continuation via SendMessage**: Store for potential later follow-ups

Example:
```
Iterative Retrieval Summary:
- Cycles used: 2 (initial + 1 follow-up)
- Additional context gathered: Error handling patterns, retry logic implementation, timeout configuration
- Agent ID: agent-abc123 (available for future continuation via SendMessage)
```

## When to Use This Skill

### Use iterative retrieval when:
- The orchestrator has semantic context the sub-agent lacks
- The query involves complex or interconnected information
- Initial results might miss important adjacent context
- The orchestrator can identify potential gaps in advance

### Don't use iterative retrieval when:
- The query is simple and well-defined (e.g., "read file X")
- The sub-agent has all needed context upfront
- Time/cost constraints are critical
- The information needed is atomic and isolated

## Examples

For detailed usage examples, see [references/examples.md](./references/examples.md) (if available).
