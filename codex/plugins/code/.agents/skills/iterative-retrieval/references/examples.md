# Iterative Retrieval Skill - Usage Examples

This document provides concrete examples of when and how to use the iterative retrieval skill effectively.

## Table of Contents

1. [When to Use: Semantic Gap Scenario](#when-to-use-semantic-gap-scenario)
2. [When NOT to Use: Simple Lookup](#when-not-to-use-simple-lookup)
3. [Complete Workflow: All 4 Phases](#complete-workflow-all-4-phases)
4. [Early Termination Example](#early-termination-example)

---

## When to Use: Semantic Gap Scenario

**Scenario:** The `/code` orchestrator needs to understand how authentication works in a codebase to implement a new protected route. The orchestrator knows it needs to understand middleware, token validation, and authorization patterns, but a code-reader sub-agent might only return what's explicitly requested without connecting the dots.

**Why iterative retrieval helps:** The orchestrator has semantic context about what "authentication flow" means end-to-end, but the sub-agent doesn't know which adjacent information is relevant without guidance.

### Initial Dispatch

```
PRIMARY OBJECTIVE: Understand the authentication flow to implement a new protected API route

INITIAL QUERIES:
- Find all authentication middleware in src/
- Show how JWT tokens are validated
- Identify where authorization checks happen

# Dispatch and store agent ID
Task(
  subagent_type="Explore",
  description="Find auth middleware and patterns",
  prompt="<queries and objective above>"
)
# Result includes agent_id: "agent-auth-789" - store this for follow-ups
```

### Sub-agent Response (First Pass)

```
Found authentication middleware in src/middleware/auth.ts:
- verifyToken() function validates JWT signatures
- Extracts user ID from token payload
- Attaches user object to request context

JWT validation uses jsonwebtoken library with RS256 algorithm.

Authorization checks found in src/middleware/authorize.ts:
- checkPermissions() function
- Compares user.role against required permissions
```

### Sufficiency Evaluation

**Applying the checklist:**
1. **Direct Answer**: Partially - shows WHERE auth happens but not HOW to integrate it
2. **Obvious Gaps**: YES - missing how to apply middleware to routes, missing error handling
3. **Adjacent Information**: YES - mentioned "required permissions" but didn't show where those are defined
4. **Confidence Check**: NO - unclear how to actually use this in a new route

**Decision:** Context insufficient → Proceed to refinement

### Refinement Request

```
# agent_id "agent-auth-789" was stored from the initial Task(...) dispatch above
SendMessage(
  to="agent-auth-789",
  summary="Follow up on auth middleware gaps",
  message="Thank you - the middleware locations and basic validation logic are helpful.

However, I need additional context:
1. How are these middleware functions applied to routes? Show examples of protected routes.
2. Where are the \"required permissions\" defined that checkPermissions() compares against?
3. What error responses are sent when auth fails?

Is there related information about authentication patterns or conventions I should know?"
)
# SendMessage returns immediately with a queued acknowledgment.
# Wait for the <task-notification> before proceeding.
# Fallback: if no agent_id is in memory (cross-session) or SendMessage returns an actual
# error, fall back to a fresh Task(...) launch with a self-contained prompt.
```

### Outcome

The orchestrator now gets the missing pieces: route protection patterns, permission configuration, error handling conventions - all critical for implementing the new route correctly.

---

## When NOT to Use: Simple Lookup

**Scenario:** The orchestrator needs to read a specific configuration file.

**Why iterative retrieval is unnecessary:** The request is atomic and well-defined. There's no semantic gap or adjacent context needed.

### Good (Direct Approach)

```
[Using Task() to dispatch code-reader]

Read the contents of config/database.json and show all connection pool settings.
```

**Sub-agent returns:** Complete file contents with pool settings.

**Result:** One-pass query is sufficient. No need for iterative retrieval.

### Bad (Over-engineering)

```
PRIMARY OBJECTIVE: Understand database configuration

INITIAL QUERIES:
- Find database config files
- Show connection pool settings

[Then follow-up]: Are there other related configurations?
```

**Why this is wasteful:** The file location is known, the content is atomic, and there's no semantic complexity. Iterative retrieval adds cost and latency without benefit.

**Rule of thumb:** If you can formulate a complete query in one sentence and the information is self-contained, don't use iterative retrieval.

---

## Complete Workflow: All 4 Phases

This example demonstrates all 4 phases of the protocol in action.

### Context

The `/code` orchestrator is implementing a new data export feature and needs to understand existing export patterns, data transformation logic, and performance considerations.

### Phase 1: Initial Dispatch

```
PRIMARY OBJECTIVE: Implement a new CSV export endpoint that follows existing export patterns and handles large datasets efficiently

INITIAL QUERIES:
- Find all existing export endpoints (JSON, CSV, etc.)
- Show how data is transformed before export
- Identify pagination or streaming patterns for large datasets

# Dispatch and store agent ID
Task(
  subagent_type="Explore",
  description="Find export patterns",
  prompt="<queries and objective above>"
)
# Store returned agent_id: "agent-export-123"
```

### Sub-agent Response (Cycle 1)

```
Found 3 export endpoints in src/api/exports/:
1. /export/users (JSON) - uses exportToJSON() helper
2. /export/transactions (CSV) - uses exportToCSV() helper
3. /export/reports (PDF) - uses generatePDF() helper

Data transformation happens in src/services/transformers/:
- userTransformer.ts: Maps DB models to export format
- transactionTransformer.ts: Flattens nested objects
- reportTransformer.ts: Aggregates data

Found streaming implementation in exportToCSV() using Node streams for memory efficiency.
```

### Phase 2: Sufficiency Evaluation (Cycle 1)

**Applying checklist:**
1. **Direct Answer**: Partially - shows WHERE code exists but not HOW to use patterns
2. **Obvious Gaps**: YES - no error handling, no rate limiting, no format validation
3. **Adjacent Information**: YES - mentioned "transformers" but didn't show structure
4. **Confidence Check**: NO - unclear how transformers integrate with streams

**Decision:** Context insufficient → Proceed to Phase 3

### Phase 3: Refinement Request (Cycle 1)

```
# agent_id "agent-export-123" was stored from the initial Task(...) dispatch above
SendMessage(
  to="agent-export-123",
  summary="Follow up on CSV export implementation details",
  message="Great - I can see the export endpoints and the streaming approach for CSVs.

I need more detail on:
1. Show the actual implementation of exportToCSV() - how does it integrate transformers with streams?
2. What error handling exists for failed exports or timeouts?
3. Are there rate limits or authentication checks on export endpoints?

Are there other export-related utilities or middleware I should know about?"
)
# SendMessage returns immediately with a queued acknowledgment.
# Wait for the <task-notification> before proceeding.
```

### Sub-agent Response (Cycle 2)

```
exportToCSV() implementation in src/helpers/csv.ts:
- Creates Transform stream from transformer functions
- Pipes data through transformer → csv-stringify → response
- Handles backpressure automatically via streams

Error handling in src/middleware/exportErrorHandler.ts:
- Catches stream errors and sends 500 response
- Logs export failures to monitoring service
- Sets timeout of 5 minutes for exports

Authentication: All /export/* routes use requireAuth + requireRole('admin') middleware

Rate limiting: Applied via exportRateLimit (10 requests per hour per user) in src/middleware/rateLimits.ts

Also found: src/utils/csvValidation.ts validates column names and data types before export
```

### Phase 2: Sufficiency Evaluation (Cycle 2)

**Applying checklist:**
1. **Direct Answer**: YES - now shows complete pattern with middleware, streaming, error handling
2. **Obvious Gaps**: NO - all major concerns addressed
3. **Adjacent Information**: YES - mentioned validation, fully explored
4. **Confidence Check**: YES - sufficient to implement new endpoint confidently

**Decision:** Context sufficient → Skip Phase 3, proceed to output

### Output Format

```
Iterative Retrieval Summary:
- Cycles used: 2 (initial dispatch + 1 follow-up)
- Additional context gathered:
  * Stream implementation details (transformer integration, backpressure)
  * Error handling patterns (middleware, timeouts, logging)
  * Security patterns (auth, rate limiting)
  * CSV validation utilities
- Agent ID: agent-export-123 (available for future continuation via SendMessage)

The orchestrator can now implement the new export endpoint following established patterns for streaming, error handling, auth, and validation.
```

---

## Early Termination Example

This example shows when Phase 2 evaluation determines that the initial response is sufficient, allowing the orchestrator to skip phases 3-4.

### Context

The orchestrator needs to understand how to add a new validation rule to an existing form.

### Phase 1: Initial Dispatch

```
PRIMARY OBJECTIVE: Add email format validation to the signup form

INITIAL QUERIES:
- Find the signup form component
- Show existing validation rules and how they're structured
- Identify the validation library being used

# Dispatch and store agent ID
Task(
  subagent_type="Explore",
  description="Find signup form validation",
  prompt="<queries and objective above>"
)
# Store returned agent_id: "agent-form-456"
```

### Sub-agent Response

```
Signup form: src/components/auth/SignupForm.tsx

Uses Zod for validation with schema defined inline:
```typescript
const signupSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  email: z.string() // Currently no validation
});
```

Form uses react-hook-form with zodResolver:
```typescript
const form = useForm({
  resolver: zodResolver(signupSchema)
});
```

To add email validation, modify the email field in signupSchema:
```typescript
email: z.string().email("Invalid email format")
```

Error messages are displayed automatically via form.formState.errors.
```

### Phase 2: Sufficiency Evaluation

**Applying checklist:**
1. **Direct Answer**: YES - shows exact location and exact change needed
2. **Obvious Gaps**: NO - validation pattern is complete and clear
3. **Adjacent Information**: NO - sub-agent didn't mention unexplored adjacent info
4. **Confidence Check**: YES - the response provides everything needed to make the change

**Decision:** Context sufficient → **EARLY TERMINATION**

### Outcome

The orchestrator **skips phases 3-4** and proceeds directly with implementation. No follow-up questions needed.

```
Iterative Retrieval Summary:
- Cycles used: 1 (initial dispatch only - sufficient context on first pass)
- Additional context gathered: N/A (initial response complete)
- Agent ID: agent-form-456 (available for future continuation via SendMessage)

Early termination: The initial response provided complete context including validation library (Zod), existing patterns, and exact syntax for email validation.
```

**Key lesson:** Even when using the iterative retrieval skill, the orchestrator should recognize when Phase 2 evaluation shows sufficiency and avoid unnecessary follow-ups. The protocol is flexible - not all 4 phases are always needed.

---

## Summary of Decision Criteria

Use these guidelines to decide whether to invoke iterative retrieval and when to terminate:

| Situation | Use Iterative Retrieval? | Why |
|-----------|-------------------------|-----|
| Complex, interconnected information | YES | Sub-agent may miss important connections |
| Orchestrator has semantic context sub-agent lacks | YES | Follow-ups can target specific gaps |
| Simple file read or lookup | NO | No semantic gap, one-pass sufficient |
| Well-defined atomic query | NO | No adjacent context needed |
| Initial response passes all 4 checklist items | NO (early termination) | Context already sufficient |

**Remember:** The skill is a tool for addressing semantic gaps, not a mandatory protocol for all sub-agent interactions.
