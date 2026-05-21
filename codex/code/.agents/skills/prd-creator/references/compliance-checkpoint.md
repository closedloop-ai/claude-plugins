# Compliance Checkpoint

Run through before finalizing PRD. Takes 2 minutes. Any "yes" = note in PRD and flag for eng.

## Sensitive Data Check

| Question | Y/N |
|----------|-----|
| Does this feature display personally identifiable information (PII)? | |
| Does this feature store new user data? | |
| Does this feature transmit user data to/from external systems? | |
| Can users export or download sensitive data? | |

**If any yes:** Note what data and why it's needed. Eng will ensure appropriate logging, encryption, and access controls.

## Access & Auth

| Question | Y/N |
|----------|-----|
| New user role or permission needed? | |
| Changes to who can see what? | |
| End-user-facing feature? | |

**If any yes:** Note the access model. Eng will implement appropriate authorization.

## Third Parties

| Question | Y/N |
|----------|-----|
| New external API or service? | |
| Sending data outside our systems? | |

**If any yes:** Flag for security/legal review if sensitive data is involved.

## Regulatory Considerations

| Question | Y/N |
|----------|-----|
| Does this feature fall under industry-specific regulations (e.g., HIPAA, GDPR, SOC 2, PCI-DSS)? | |
| Does this feature affect data retention or deletion policies? | |
| Are there geographic/jurisdictional requirements for data storage? | |

**If any yes:** Note applicable regulations. Eng + compliance will sort details.

## Quick Reference

**PII = Any data that can identify a person.** Names, emails, phone numbers, addresses, payment info, IP addresses, etc.

**Common sensitive data:** Authentication credentials, payment details, personal communications, usage data tied to identifiable users, health records, financial records.

**Generally not sensitive:** Aggregate/anonymous data, system logs without user context, public configuration.

---

*Don't overthink it. Flag concerns, eng + compliance will sort details.*

---

## What Happens Next (Symphony Integration)

When you run your PRD through Symphony (`/code`):

1. **prd-analyst** extracts your compliance flags into `constraints[]`
2. **security-privacy** critic automatically reviews the implementation plan for:
   - Sensitive data handling patterns
   - Access control implementation
   - Audit logging requirements
   - Third-party data sharing
3. **plan-verifier** ensures every compliance constraint maps to implementation tasks

Your job: flag the concerns. Symphony's job: ensure they're addressed in the plan.
