# CariGaji Agent Usage Guide

## Default Entry Point
Use the Orchestrator as the root intake agent for most requests.

Recommended user prompt style:
- Goal: what outcome you want
- Scope: files or features in/out
- Constraints: deadlines, risk tolerance, no-migration/no-refactor preferences
- Validation: how to confirm done

## Orchestrator Modes

### Sequential Mode (default for code changes)
Used for implementation and bug fixes where write operations must stay ordered.

Typical flow:
1. Planner (if scope is unclear)
2. Explorer (if ownership is unclear)
3. Feature Developer or Debugger
4. Test Runner
5. Code Reviewer
6. Security Reviewer (required for high-risk changes)
7. Docs Agent (if behavior/setup changed)

### Coherent Parallel Mode (analysis-first)
Used when read-only analysis can be parallelized safely.

Parallel-safe bundles:
- Explorer + Code Reviewer + Security Reviewer
- Planner + Explorer

After parallel analysis, execution returns to sequential steps for edits and validation.

## Agent Responsibilities
- Planner: break work into a minimal, testable plan.
- Explorer: map code/data flow and gather evidence.
- Feature Developer: implement focused code changes.
- Debugger: isolate root cause and minimal fix path.
- Test Runner: run validation and report pass/fail proof.
- Code Reviewer: find regressions and maintainability defects.
- Security Reviewer: inspect auth/secrets/data exposure risks.
- Docs Agent: update docs to match behavior.

## Risk Rules
- High risk (auth, RLS, secrets, storage paths, migrations, payout/payment): security review is mandatory.
- Behavior changes: test validation is mandatory.
- Any failing check blocks completion until resolved or explicitly accepted.

## Explorer Live Web Search
Explorer can use MCP-backed live web search via DuckDuckGo when external confirmation is needed.

Use cases:
- Confirm third-party API behavior or policy docs.
- Cross-check library/version migration guidance.
- Validate current best-practice references before proposing changes.

## Ready-to-Use Prompts
- "Use orchestrator in sequential mode: implement X in scope Y, no schema changes, validate with npm test."
- "Use orchestrator in coherent parallel mode to assess security and regression risk for this diff."
- "Use orchestrator to debug payout scheduling; prioritize minimal fix and include targeted validation."
- "Use orchestrator with high-risk policy: require security review before finalizing."
