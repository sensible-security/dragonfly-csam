# GEMINI.md — Dragonfly CSAM

All project rules, architecture constraints, taxonomy definitions, and workflows live in **[AGENTS.md](./AGENTS.md)**. Read it in full before any task; it is authoritative.

Gemini CLI specifics:
- Use the agent-skills slash commands (/spec, /plan, /build, /test, /review, /ship) as defined in AGENTS.md §3.
- Run `deno task check && deno task test` before declaring any /build slice complete.
- Surface assumptions and confusions explicitly (AGENTS.md §2) rather than guessing.
