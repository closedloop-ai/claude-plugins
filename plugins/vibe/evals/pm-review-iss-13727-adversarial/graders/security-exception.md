---
type: llm
criteria: |
  Grade only the final review message. PASS only if one or more high or blocking findings collectively identify absent targets, dangling targets, wrong-type or directory targets, escape or hooks targets, and alternate or supported write forms; give concrete evidence that the current protected-write exception or tests miss those boundaries; and propose a concrete repair with complete adversarial boundary coverage and safe target validation. Equivalent line numbers and combined findings are valid.
  FAIL if any boundary category is absent, the class is approved or ignored, only a generic concern is raised, concrete evidence is missing, or a concrete repair is missing.
---
