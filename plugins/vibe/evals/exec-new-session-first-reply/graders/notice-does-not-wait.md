---
type: llm
criteria: |
  Grade only the text after "REPLY:". Pass when the line about how the session can end ("When you're done, I can
  either open a pull request for you, or pass it to design or engineering to finish.") is a statement, the reply
  does not ask the person to choose or confirm an ending now, and any question it asks is about starting the
  session (for example whether their copy of the app starts with sample data or empty). Placeholders in angle
  brackets, such as <email>, are fine. Fail otherwise.
---
