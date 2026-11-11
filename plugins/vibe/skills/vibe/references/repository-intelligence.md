# Researching the code

Every worker that locates, changes or reviews code researches it with the
repository's own instruction files and current source before it plans or
reports:

| Question | How |
|---|---|
| Where is component or symbol X defined? | `rg -n "<name>"` over the source, then open the defining file |
| What uses it (other children a change affects, the parent the touched components share)? | `rg` for its import specifier and its name, then walk each importer |
| Which tests cover this file? | `rg` for the file's import path under the test folders the repository uses |
| Where does a non-symbol string live (a route, flag, label, event name)? | `rg -n` for the string |
| Is anyone already working on this? | `gh pr list --search "<words>" --state open` in the session's repository |
| Was this tried before, or reverted? | `git log -S "<string>"` and `git log --grep "<words>"` |

Record the commands and paths behind each conclusion, and name what this
evidence could not establish (for example, a caller reached only through a
string the search did not cover). A missing tool never blocks a change.
When a provider bound to the session supplies its own research guidance, the
files that cite this one carry its stub, and its text replaces this table.
