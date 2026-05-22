# Chain of Thought Reference

Detailed guidance on implementing chain of thought (CoT) prompting.

## When to Use CoT

**Good candidates:**
- Math and calculations
- Multi-step logic problems
- Analysis requiring multiple factors
- Decisions with trade-offs
- Complex document interpretation
- Tasks a human would need to think through

**Skip CoT for:**
- Simple factual lookups
- Straightforward transformations
- Tasks where latency matters more than depth

## Implementation Levels

### Level 1: Basic

Add "Think step-by-step" to your prompt:

```
Solve this problem. Think step-by-step.
```

**Pros:** Simple, quick
**Cons:** Less control over reasoning process

### Level 2: Guided

Provide specific steps to follow:

```
Think through this problem:
1. First, identify the key variables
2. Then, determine the relationships between them
3. Finally, calculate the result
```

**Pros:** More control, consistent reasoning structure
**Cons:** May constrain creative problem-solving

### Level 3: Structured with Tags

Separate reasoning from final answer:

```
Think through this problem in <thinking> tags.
Provide your final answer in <answer> tags.
```

**Pros:** Easy to parse, clean output separation
**Cons:** Slightly more complex prompts

## Example: Structured CoT

**Prompt:**
```
You're a financial advisor. A client wants to invest $10,000 for 5 years.
Option A: Stock with 12% historical return but volatile.
Option B: Bond guaranteeing 6% annually.

Think step-by-step in <thinking> tags. Provide recommendation in <answer> tags.
```

**Response pattern:**
```
<thinking>
1. Client goal: Down payment in 5 years (non-negotiable timeline)
2. Option A analysis:
   - Best case (12% annually): $10,000 * 1.12^5 = $17,623
   - Worst case (market crash): Could lose 50%+
3. Option B analysis:
   - Guaranteed: $10,000 * 1.06^5 = $13,382
4. Risk assessment:
   - Short timeline limits recovery from downturns
   - Goal is essential (house), not discretionary
5. Conclusion: Certainty outweighs potential gain
</thinking>

<answer>
Recommend Option B. The guaranteed $13,382 ensures the client meets
their down payment goal. With only 5 years and an essential goal,
the stock's volatility poses unacceptable risk.
</answer>
```

## Debugging with CoT

CoT reveals Claude's reasoning, making it easier to identify where prompts need refinement:

1. **Spot misunderstandings:** See which instructions Claude interpreted incorrectly
2. **Identify missing context:** Notice when Claude makes assumptions you didn't intend
3. **Find logic gaps:** Trace where reasoning went wrong

## Combining with Other Techniques

### CoT + Examples
```
Here's how to analyze a problem:

<example>
Problem: Calculate 15% of 80
<thinking>
1. Convert 15% to decimal: 0.15
2. Multiply: 0.15 * 80 = 12
</thinking>
<answer>12</answer>
</example>

Now solve: What is 35% of 240?
```

### CoT + Role Prompting
```
system: "You are a senior software architect."

user: "Review this database schema for scalability issues.
Think through potential bottlenecks in <thinking> tags.
List recommendations in <recommendations> tags."
```

## Key Insight

**Always output thinking.** Without outputting the thought process, no actual step-by-step reasoning occurs. The act of generating the thinking tokens is what produces better results.
