# AI Rules

## House Rules

 - Use subagents for tasks
 - Use multiple subagents in parallel working as a team, with agent messaging to co-ordinate.
 - Subagents must use an appropriate model, defaults:
   - Explore, Coding, Code Reviews: Sonnet / Terra
   - Codebase Mapping: jcodemunch MCP and Sonnet / Terra
   - Reasoning and Planning: Opus / Sol
   - Trivial, Documentation: Haiku / Luna
 - Explicitly specify the model when starting a subagent.
 - Subagents must use an appropriate subagent type.
 - Do not start a subagent without explicitly setting the model.
 - When building UI to match a mockup, it MUST match the mockup
 - When work is complete, before merging or finishing, run /no-comments

## Agent skills

### Issue tracker

GitHub Issues on `mintopia/cc-acp-mod`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Code Exploration Policy

Always use jCodeMunch-MCP for code navigation. Never fall back to Read, Grep, Glob, or Bash for code exploration.
**Exception:** use `Read` when you are about to edit a file — the harness requires a `Read` before `Edit`/`Write`. Use jCodeMunch to *find and understand* code, then `Read` only the file you are changing.

This server runs the **front door** surface: three tools reach every jCodeMunch capability, so the tool list stays small and the catalogue is fetched only when you need it.

**Start any session:**
1. `order { "action": "resolve_repo", "args": { "path": "." } }` — confirm the project is indexed. If it is not: `order { "action": "index_folder", "args": { "path": "." } }`

**Then, for any task:**
- Know what you want → `order { "action": "<name>", "args": { ... } }`
- Know the goal, not the tool → `route { "query": "your task in a sentence" }` picks the action and shapes the arguments
- Want to see what exists → `menu { "query": "what you are trying to do" }` returns matching actions with example arguments
- Want the whole catalogue and the usage rules → `jcodemunch_guide`

`menu` and `jcodemunch_guide` list every action this server can run, including ones absent from your tool list. That is expected: the front door is the way to call them.

**Interpreting results:**
- A `verdict` of `no_implementation_found` is evidence of absence. Report the gap; do not re-search with different wording.
- A `verdict` of `degraded` means a channel was unavailable, so absence is NOT proven. Read the note before relying on the result.
- `source: ""` alongside `source_status` means the body could not be read, not that the symbol is empty.

**After editing files:**
- With PostToolUse hooks installed (Claude Code), edited files are reindexed automatically.
- Otherwise `order { "action": "register_edit", "args": { "paths": [...] } }` after an edit, batched for bulk changes.

**Announce your model once per session** so the server can size its answers: `announce_model { "model": "<your-model-id>" }`.

