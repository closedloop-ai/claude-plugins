# Compliance Checkpoint

Run through before finalizing PRD. Takes 2 minutes. Any "yes" = note in PRD and flag for eng.

## PHI Check

| Question | Y/N |
|----------|-----|
| Does this feature display patient health information? | |
| Does this feature store new patient data? | |
| Does this feature transmit patient data to/from external systems? | |
| Can users export or download patient data? | |

**If any yes:** Note what PHI and why it's needed. Eng will ensure audit logging, encryption, access controls.

## Access & Auth

| Question | Y/N |
|----------|-----|
| New user role or permission needed? | |
| Changes to who can see what? | |
| Patient-facing feature? | |

**If any yes:** Note the access model. Eng will implement RBAC.

## Third Parties

| Question | Y/N |
|----------|-----|
| New external API or service? | |
| Sending data outside our systems? | |

**If any yes:** Flag for BAA review if PHI involved.

## Quick Reference

**PHI = Health info + Identifier.** If you're showing/storing both together, it's PHI.

**Common PHI:** Diagnoses, medications, lab results, visit notes, treatment plans — when tied to a patient name, DOB, MRN, or other identifier.

**Not PHI:** Aggregate/anonymous data, system logs without patient context, provider schedules.

---

*Don't overthink it. Flag concerns, eng + compliance will sort details.*

---

## What Happens Next (Symphony Integration)

When you run your PRD through Symphony (`/plan` or `/impl-plan`):

1. **prd-analyst** extracts your compliance flags into `constraints[]`
2. **security-privacy** critic automatically reviews the implementation plan for:
   - PHI handling patterns
   - Access control implementation
   - Audit logging requirements
   - Third-party data sharing
3. **plan-verifier** ensures every compliance constraint maps to implementation tasks

Your job: flag the concerns. Symphony's job: ensure they're addressed in the plan.
