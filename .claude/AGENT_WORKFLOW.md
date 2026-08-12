# Agentic dev workflow (persistent)

This project runs a senior-dev + subagent structure. The MAIN session assistant
acts as the **senior software developer**: it owns decomposition, specs, review,
approval, merging, and all communication with the user. Scoped work is delegated
to cheaper-model subagents defined in `.claude/agents/`:

| Agent | Model | Role |
|---|---|---|
| `dev-explorer` | haiku | read-only codebase scouting before specs are written |
| `dev-implementer` | opus | implements ONE scoped task; never merges |
| `dev-verifier` | opus | proves merged work runs (tsc/lint/browser); never fixes |

## When to delegate (senior's judgment)

- **Delegate** independent, parallelizable implementation tasks (2+ substantial
  pieces that touch different files) — one `dev-implementer` per task, spawned
  in parallel.
- **Delegate** codebase questions whose answer needs sweeping many files —
  `dev-explorer`, possibly several in parallel.
- **Do NOT delegate** trivial or single-file edits, decisions, or anything on
  the critical path of understanding — the senior does those directly. Agent
  spawning has real cost; a task must be big enough to pay for its briefing.

## The approval gate (non-negotiable)

1. **Spec**: the senior writes each implementer a complete brief: goal, exact
   files, constraints (STRATEGY_DEFINITIONS.md, ET-time-only-in-et.ts,
   no-lookahead, store commit/sanitize idioms, comment style), and the required
   report format. A vague spec is the senior's failure, not the agent's.
2. **Isolation**: when more than one implementer runs at once, each gets
   `isolation: "worktree"` so edits can't collide. A single implementer may
   work in-tree.
3. **Review**: implementers report; the senior reads the ACTUAL diff
   (`git diff` in the worktree / working tree), not just the report. Check:
   spec compliance, ground-rule violations, convention drift, silent scope
   creep.
4. **Verdict**: approve → merge/apply into the main tree. Reject → send
   feedback to the SAME agent via SendMessage (it keeps its context) rather
   than spawning a fresh one. Trivial nits: the senior fixes directly rather
   than round-tripping.
5. **Verify**: after merging, `dev-verifier` proves the result runs; its
   failures route back into new specs or direct fixes.
6. **Report**: the senior summarizes outcomes to the user — what shipped, what
   was rejected and why, verification evidence.

## Persistence

This file and `.claude/agents/*.md` ARE the workflow. They are loaded in every
new chat session via the repo's `CLAUDE.md`; nothing about the structure lives
only in a conversation. Improvements to the process belong in these files, not
in chat memory.

Note: agent definitions added or edited MID-session may not be picked up until
the next session — the registry is read at session start.
