# Story Patterns

Quick-start patterns for common software features. Copy, customize, generate more with AI.

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

**Role-Based Access**
```
As an admin, I want to manage team member permissions so that users only see what they need.
AC:
- Admin can assign roles to team members
- Permission changes take effect immediately
- Audit log records permission changes
```

**Delegated Access**
```
As a team lead, I want to grant temporary access to a contractor so that they can contribute to a project.
AC:
- Access has an expiration date
- Delegated actions are logged separately
- Access can be revoked anytime
```

---

## Data & Content

**View Data**
```
As a [user], I want to view [data type] so that [reason].
AC:
- Loads in <[N]s>
- Only authorized users see it
- Pagination/filtering available for large datasets
```

**Search**
```
As a [user], I want to search for [thing] so that I can find it quickly.
AC:
- Supports [search fields]
- Results scoped to user's access level
- Returns results within [N]ms
```

**Export**
```
As a [user], I want to export [data] so that I can use it externally.
AC:
- Supports [CSV/PDF/JSON] format
- Export respects current filters
- Large exports are processed asynchronously with notification on completion
```

---

## Messaging & Notifications

**Send Message**
```
As a [user], I want to send a message so that I can communicate with my team.
AC:
- Character limit: [N]
- Recipient options based on team membership
- Delivery confirmation shown
```

**Notifications**
```
As a [user], I want to receive notifications so that I stay informed about relevant activity.
AC:
- Configurable notification preferences (email, in-app, push)
- Respects quiet hours if set
- Notification links to relevant context
```

---

## CRUD Operations

**Create**
```
As a [user], I want to create a [resource] so that [reason].
AC:
- Required fields validated before save
- Success confirmation shown
- Created resource appears in list immediately
```

**Edit**
```
As a [user], I want to edit a [resource] so that I can keep information current.
AC:
- Changes saved and confirmation shown
- Edit history maintained
- Concurrent edits handled gracefully
```

---

## Compliance Add-Ons

Add to any story touching sensitive data:
```
Compliance:
- [ ] Access logged
- [ ] Minimum necessary data displayed
- [ ] Encrypted in transit/at rest
```

---

## Tips

- **Start sparse.** Add AC during refinement, not upfront.
- **AI can expand.** Ask Claude to generate edge cases when needed.
- **Copy liberally.** These are starting points, not sacred text.
