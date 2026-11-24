const WAITS_FOR_PERSON = /\b(?:flags?|feature flag|switch(?:es)?|toggles?|credentials?|password|token|sign(?:ed)?[ -]?in|log ?in|delete|discard|destroy|drop|force|wording|copy|say|says|label|skip|narrow|defer|exclude|descope|obsolete|out of scope)\b/i;

/** A flag, copy, destructive, credential or scope-narrowing question always waits for the person. */
export function waitsForPerson(question) {
  return WAITS_FOR_PERSON.test(question);
}
