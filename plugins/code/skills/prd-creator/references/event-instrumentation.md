# Event Instrumentation Checklist

Reference for defining analytics events in PRDs. Ensures events follow organizational standards for naming, structure, and platform placement.

Source: [Confluence - Event Instrumentation Checklist](https://closedloop.atlassian.net/wiki/spaces/HEAL/pages/4453400577/Event+Instrumentation+Checklist)

---

## Formatting Requirements

| Element | Format | Example |
|---------|--------|---------|
| Event names | Title Case | "Page Viewed", "Button Clicked" |
| Property names | snake_case | `page_name`, `button_name` |
| Property values | PascalCase | "NameOfPage", "Context:ButtonText" |

---

## Common Event Types

### Page Viewed

Fire on every page to track views.

**Required properties:**
- `page_name` = "NameOfPage"

### Button Clicked

Fire on any button click to track.

**Required properties:**
- `button_name` = "Context:ButtonText" (e.g., "FTUE:CallDoctor", "Plans:DeletePlan")
- `page_name` = "NameOfPage"
- Any dynamic IDs (e.g., `module_id`, `entity_id`, `conversation_id`)

### Interaction Event

Use for events that are not page views or button clicks.

**Examples:**
- User taps into an input field: `interaction_type: "FocusAreaTarget:Tapped"`
- Daily activities displayed: `interaction_type: "Plans:ActivitiesDisplayed"`

**Required properties:**
- `interaction_type`
- `page_name`
- Any dynamic IDs (e.g., `module_id`, `entity_id`, `conversation_id`)

### Backend Events

Common backend event types:
- `Message Created`
- `Thread Created`
- `Notification Sent`

**Note:** New event types require Product team approval.

---

## When to Use Backend vs Frontend Events

### Use Backend (BE) Events For:

1. **Source-of-Truth Events**
   - Critical, canonical actions (plan creation, goal achievement, user data changes)
   - Must be accurate for business or audit purposes
   - Cannot be spoofed by users

2. **Triggers**
   - Events driving business logic beyond analytics
   - Email triggers, notifications, user state changes, audit logging

3. **PHI-Containing Events**
   - Privacy-sensitive events (HIPAA-relevant info)
   - Backend enforces security and logging requirements

### Use Frontend (FE) Events For:

1. **UX Behavior/Interactions**
   - Button clicks, page views, navigation, UI-level micro events
   - Funnel analysis, A/B test exposure, interaction drop-offs

2. **Experiments**
   - Fast iteration/experimentation for product/UX discovery

3. **Lossy-Tolerant Actions**
   - Data that isn't business- or compliance-critical
   - Can tolerate some inaccuracy

### Use Both (With Deduplication):

- Key conversion actions happening on both client and server
- Example: "Create Plan" button press (FE) vs server-acknowledged plan creation (BE)
- Ensure clear deduplication in reporting
- Treat backend as source of truth

### Summary Rules:

- Plan for compliance/auditability from day one — use BE for critical health/goal lifecycle changes
- Use FE for granular interaction, onboarding, and discovery — focus on learning, don't over-instrument
- Never rely solely on FE for core business or regulatory metrics
- Document grey areas (dual-source events) aggressively
- **When in doubt, default to BE for anything serious. FE is for learning, not accounting.**

---

## Platform Tagging

Tag events clearly:
- `MOBILE ONLY`
- `DESKTOP ONLY`
- `BACKEND ONLY`

Document any conditional logic (e.g., App Install only fires with UTM params).

---

## PRD Documentation Format

### Event Table

| Event | Properties | Description | Platform |
|-------|------------|-------------|----------|
| [Event Name] | [property: value, ...] | [Purpose, conditions, edge cases] | [FE/BE/Both] |

### For Each Event, Document:

1. **Trigger** — What precisely triggers it? ("BE saves new plan object" not "user clicks next")
2. **Decisions Supported** — What decisions does it support? ("Used to power D1 retention queries")
3. **Compliance** — Is this event capturing compliance-sensitive data?

### User Properties

Document any user properties that should be created or updated:

| Property | Updated When | New Value |
|----------|--------------|-----------|
| [property_name] | [Event that triggers update] | [New value] |
