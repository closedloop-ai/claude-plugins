# Extended Thinking Reference

Guidance for using Claude's extended thinking mode for complex reasoning tasks.

## What is Extended Thinking?

Extended thinking allows Claude to work through complex problems step-by-step before responding. Unlike standard chain-of-thought prompting, extended thinking uses a dedicated thinking budget and separate thinking blocks.

## When to Use Extended Thinking

**Best candidates:**
- Complex STEM problems (math, physics, code architecture)
- Constraint optimization (multiple competing requirements)
- Problems requiring structured analytical frameworks
- Tasks benefiting from verification and self-correction

**Skip for:**
- Simple questions where latency matters
- Tasks that work well with standard CoT
- When thinking budget constraints are tight

## Technical Considerations

| Setting | Recommendation |
|---------|----------------|
| Minimum budget | 1024 tokens |
| Starting point | Begin at minimum, increase as needed |
| Large budgets (>32K) | Use batch processing to avoid timeouts |
| Language | Performs best in English (outputs can be any language) |

## Prompting Best Practices

### 1. General Instructions First

Claude often performs better with high-level guidance rather than prescriptive steps:

**Less effective:**
```
Think through this math problem step by step:
1. First, identify the variables
2. Then, set up the equation
3. Next, solve for x
...
```

**More effective:**
```
Please think about this math problem thoroughly and in great detail.
Consider multiple approaches and show your complete reasoning.
Try different methods if your first approach doesn't work.
```

### 2. Multishot with Thinking Tags

Show examples of thinking patterns using `<thinking>` or `<scratchpad>` tags:

```
I'm going to show you how to solve a problem, then solve a similar one.

Problem 1: What is 15% of 80?

<thinking>
To find 15% of 80:
1. Convert 15% to a decimal: 15% = 0.15
2. Multiply: 0.15 x 80 = 12
</thinking>

The answer is 12.

Now solve: What is 35% of 240?
```

### 3. Self-Verification

Ask Claude to verify its work:

```
Write a function to calculate factorial.
Before finishing, verify your solution with test cases:
- n=0
- n=1
- n=5
- n=10
Fix any issues you find.
```

## Use Case Examples

### Complex STEM

```
Write a Python script for a bouncing ball within a tesseract,
handling collision detection properly.
Make the tesseract slowly rotate.
Ensure the ball stays within the tesseract.
```

### Constraint Optimization

```
Plan a 7-day trip to Japan with these constraints:
- Budget: $2,500
- Must include Tokyo and Kyoto
- Vegetarian diet accommodation
- Cultural experiences over shopping
- One day of hiking
- Max 2 hours travel between locations per day
- Free time each afternoon for calls
- Avoid crowds where possible
```

### Analytical Frameworks

```
Develop a strategy for Microsoft entering personalized medicine by 2027.

Begin with:
1. A Blue Ocean Strategy canvas
2. Porter's Five Forces analysis

Then conduct scenario planning with four futures based on
regulatory and technological variables.

For each scenario, develop responses using the Ansoff Matrix.

Finally, apply Three Horizons framework to map the transition.
```

## What NOT to Do

1. **Don't pass thinking back:** Don't include Claude's extended thinking in follow-up user messages
2. **Don't prefill with extended thinking:** Prefilling is not allowed with extended thinking mode
3. **Don't request excessive tokens:** Start small and increase only as needed
4. **Don't use prescriptive steps initially:** Let Claude find the best approach first

## Debugging Extended Thinking

Use thinking output to understand Claude's reasoning, then iterate:

1. Review thinking to identify where reasoning diverged
2. Add more specific instructions for problematic areas
3. Provide examples that demonstrate correct reasoning
4. Adjust thinking budget if reasoning seems truncated

## Key Insight

Extended thinking is for problems where the optimal approach isn't obvious. Let Claude explore—its problem-solving creativity may exceed your ability to prescribe the perfect steps.
