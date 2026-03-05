# Story Patterns

Quick-start patterns for common healthcare features. Copy, customize, generate more with AI.

## Story Format
```
As a [persona], I want [what] so that [why].
```

## Acceptance Criteria Format
```
Given [context], when [action], then [result].
```

---

## Auth & Access

**Login**
```
As a user, I want to log in so that I can access my account.
AC:
- Given valid credentials, when I submit, then I'm logged in
- Given invalid credentials, when I submit, then I see an error (no detail leak)
- Given [N] failed attempts, then account is locked
```

**Proxy Access** (common in healthcare)
```
As a caregiver, I want to access my family member's info so that I can help manage their care.
AC:
- Patient must authorize access
- Proxy actions logged separately
- Patient can revoke anytime
```

---

## Patient Data

**View Data**
```
As a [clinician/patient], I want to view [data type] so that [reason].
AC:
- Loads in <[N]s>
- Access logged
- Only authorized users see it
```

**Search**
```
As a [user], I want to search for [thing] so that I can find it quickly.
AC:
- Supports [search fields]
- Results scoped to user's access
- Search logged if PHI involved
```

---

## Messaging

**Send Message**
```
As a [patient/provider], I want to send a message so that I can communicate asynchronously.
AC:
- Character limit: [N]
- Recipient options based on relationships
- Delivery confirmation shown
- No PHI in email/push previews
```

---

## Clinical (if applicable)

**Document**
```
As a clinician, I want to document [note type] so that the record is updated.
AC:
- Associates with correct patient/encounter
- Auto-saves
- Locked after signing
- Audit trail maintained
```

---

## Compliance Add-Ons

Add to any story touching PHI:
```
Compliance:
- [ ] Access logged
- [ ] Minimum necessary data
- [ ] Encrypted in transit/at rest
```

---

## Tips

- **Start sparse.** Add AC during refinement, not upfront.
- **AI can expand.** Ask Claude to generate edge cases when needed.
- **Copy liberally.** These are starting points, not sacred text.
