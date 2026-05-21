# TOON Format Examples

## Basic Array Examples

### Simple Primitive Array (Comma-Delimited)

```toon
tags[3]: admin,ops,dev
```

### Primitive Array with Pipe Delimiter

```toon
roles[3|]: admin|ops|dev
```

### Primitive Array with Tab Delimiter

```toon
cols[3	]: col1	col2	col3
```

## Tabular Array Examples (Uniform Object Arrays)

### Basic Tabular Array

```toon
users[3]{id,name,email}:
  1,Alice,alice@example.com
  2,Bob,bob@example.com
  3,Carol,carol@example.com
```

### Tabular Array with Empty Fields

Empty fields are represented by nothing between delimiters:

```toon
items[3]{id,name,description}:
  1,Widget,A useful widget
  2,Gadget,
  3,,No name provided
```

### Tabular Array with Quoted Summaries

When fields contain commas, they MUST be quoted:

```toon
patterns[2]{id,category,summary,confidence}:
  P-001,pattern,"Always use tokens, not raw values",high
  P-002,mistake,"Check auth first, then validate input",medium
```

### Tabular Array with Pipe-Separated Sub-Arrays

Fields that contain multiple values use pipe (`|`) within the comma-delimited row:

```toon
patterns[2]{id,applies_to,context}:
  P-001,plan-writer|implementation-subagent,API|auth|security
  P-002,*,UI|styling
```

## Object Examples

### Simple Object

```toon
user:
  id: 123
  name: Ada
  active: true
```

### Nested Object

```toon
user:
  id: 123
  name: Ada
  profile:
    bio: Developer
    active: true
    settings:
      theme: dark
      notifications: false
```

## Mixed Array Examples

### Array with Mixed Types

```toon
items[3]:
  - 42
  - hello
  - nested:
      key: value
```

### Array of Arrays

```toon
pairs[2]:
  - [2]: 1,2
  - [2]: 3,4
```

## org-patterns.toon Complete Example

This is the standard format for ClosedLoop organization learnings:

```toon
# Organization Patterns (TOON format)
# Last updated: 2024-01-15T10:30:00Z
# Total: 6 | Flagged: 2

patterns[6]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context}:
  P-001,pattern,"Always use Tamagui tokens for colors",high,5,0.85,,implementation-subagent,UI|styling
  P-002,mistake,"Auth middleware must come before route handlers",high,3,0.78,,implementation-subagent|verification-subagent,API|auth
  P-003,pattern,"Use React Query for API calls",low,2,0.33,[REVIEW],implementation-subagent,data-fetching
  P-004,convention,"Prefer named exports over default exports",medium,4,0.60,,*,code-style
  P-005,convention,"Run yarn lint before committing",high,7,,[STALE],*,workflow
  P-006,insight,"This repo typically needs 4+ iterations",medium,3,0.75,,orchestrator,workflow|iterations
```

### Field Breakdown

| Field | Example Values | Notes |
|-------|----------------|-------|
| `id` | `P-001` | Pattern identifier |
| `category` | `pattern`, `mistake`, `convention`, `insight` | Enum |
| `summary` | `"Always use tokens, not raw values"` | **Always quoted** |
| `confidence` | `high`, `medium`, `low` | Enum |
| `seen_count` | `5` | Integer |
| `success_rate` | `0.85`, `` (empty) | Float or empty |
| `flags` | `[REVIEW]`, `[STALE]`, `` | Bracketed or empty |
| `applies_to` | `implementation-subagent`, `*` | Pipe-separated |
| `context` | `UI\|styling` | Pipe-separated tags |

## Quoting Examples

### Strings That MUST Be Quoted

```toon
# Contains comma (the active delimiter)
summary: "Use tokens, not raw values"

# Reserved literal
value: "true"

# Numeric-like
version: "123"

# Leading/trailing whitespace
padded: " hello "

# Contains colon
label: "key:value"

# Contains quotes (escaped)
message: "She said \"hello\""

# Leading hyphen
flag: "-verbose"

# Contains brackets
selector: "[data-id]"
```

### Strings That Don't Need Quoting

```toon
# Simple alphanumeric
name: Alice

# Hyphenated (no leading hyphen)
agent: implementation-subagent

# Path-like (no reserved chars)
context: UI|styling
```

## Common Mistakes and Corrections

### Mistake 1: Unquoted String with Comma

```toon
# WRONG - breaks field parsing
patterns[1]{id,summary}:
  P-001,Use tokens, not values

# CORRECT - summary is quoted
patterns[1]{id,summary}:
  P-001,"Use tokens, not values"
```

### Mistake 2: Tab Indentation

```toon
# WRONG - tabs not allowed
patterns[1]{id}:
	P-001

# CORRECT - 2 spaces
patterns[1]{id}:
  P-001
```

### Mistake 3: Count Mismatch

```toon
# WRONG - says 2, has 3 items
items[2]: a,b,c

# CORRECT - accurate count
items[3]: a,b,c
```

### Mistake 4: Blank Lines in Array Block

```toon
# WRONG - blank line breaks array
patterns[2]{id,name}:
  P-001,First

  P-002,Second

# CORRECT - no blank lines
patterns[2]{id,name}:
  P-001,First
  P-002,Second
```

### Mistake 5: Wrong Indentation Level

```toon
# WRONG - 4 spaces instead of 2
patterns[1]{id}:
    P-001

# CORRECT - exactly 2 spaces
patterns[1]{id}:
  P-001
```
