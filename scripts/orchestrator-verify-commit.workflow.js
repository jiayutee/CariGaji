// Workflow script — the "verify/commit slice" of the orchestrator loop.
//
// NOT wired into scripts/orchestrator-runner.sh yet, and not on by default
// even if it were — see the flag-gate note in SKILL.trimmed-draft.md's
// STEP 4. This is a draft: it replaces STEP 4-7 of SKILL.md (execute ->
// build gate -> commit/push -> Notion update -> deploy) with deterministic
// control flow and schema-validated agent output, for the class of bug
// that keeps recurring when those steps are prose instructions an LLM has
// to remember to follow every 2-hour cycle: a silent no-op Notion write, a
// turn-limit truncation misread as a clean review, a build gate skipped
// under turn pressure.
//
// STEP 0-3 (Telegram intake, ambiguity handling, agenda pick, risk
// classification) stay OUTSIDE this script on purpose -- those need an
// LLM's judgment on unstructured input, not a fixed pipeline shape.
//
// Revised after a first pass flagged real gaps against the thing it
// replaces — each is addressed below and tagged [ADDRESSED: n] against the
// numbered disadvantage list this came from:
//   1. Feature Backlog Status+Date coupling (the actual 38%-defect-rate
//      rule) was left unmechanized. Now mechanized in the Notion phase.
//   2. No Planner stage for multi-file work. Now conditional on
//      args.task.multiFile.
//   3. A single hardcoded retry replaced open-ended "fix it first". Now a
//      bounded attempt loop (default 2, tunable) that carries the actual
//      failure reason into the next attempt instead of a blind redo.
//   4. Higher token cost per item than one inline session. Not solved —
//      genuinely more expensive per landed task — but bounded: attempts
//      are capped, not open-ended, and adoption is opt-in via the flag
//      file (see disadvantage 7), so real quota impact is observable
//      before this runs unattended by default.
//   5. Dashboard blind spot. Fixed in scripts/orchestrator-watch.py, which
//      now recognizes a "Workflow" tool_use/tool_result pair in the
//      caller's own transcript the same way it already recognizes
//      Task/Agent spawns — no need to parse a separate journal format.
//   6. Harder to hot-patch under incident pressure. Partially addressed:
//      the rules most likely to need a same-day fix (Notion write shapes,
//      the build gate command) are pulled into the named constants right
//      below, so patching one is "edit a string," not "edit control flow."
//   7. Turning this on for an unattended cron job is a bigger decision than
//      it looks. Addressed in SKILL.trimmed-draft.md, not here: STEP 4
//      only takes this path if a flag file exists, and defaults to the
//      legacy behavior otherwise.

export const meta = {
  name: 'carigaji-verify-commit',
  description: 'Land one agenda item: (plan) -> implement -> verify -> build-gate -> merge/push -> Notion confirm -> deploy-check',
  phases: [
    { title: 'Plan', detail: 'planner pass — only for multi-file tasks' },
    { title: 'Implement', detail: 'feature-dev or debugger, isolated in a worktree' },
    { title: 'Verify', detail: 'code-reviewer (+ security-reviewer if risk >= medium) on the diff' },
    { title: 'Build Gate', detail: 'esbuild syntax check before anything lands on main' },
    { title: 'Land', detail: 'merge the worktree branch into main and push' },
    { title: 'Notion', detail: 'Daily Log commit-hash write + Backlog Status/Date write, both re-fetched to confirm' },
    { title: 'Deploy', detail: 'force a Pages publish and confirm the live site changed' },
  ],
}

// ── quick-patch knobs [ADDRESSED: 6] ───────────────────────────────────────
// The rules most likely to need a same-day fix after an incident, as named
// constants instead of buried in prompt strings — editing one of these is
// the same motion as editing a SKILL.md paragraph, just scoped to one line.
const BUILD_GATE_CMD = 'npx esbuild carigaji-app.jsx --bundle=false --platform=browser > /dev/null'
const NOTION_WRITE_RULES =
  'Fetch and concatenate existing fields before writing — never overwrite a growing field. ' +
  'A rich_text field over ~2000 chars in one element will 400 — split across elements. ' +
  'update_properties wants plain string/number/null values, never a nested {select:{name}} object.'
const DEFAULT_MAX_ATTEMPTS = 2

// ── schemas ────────────────────────────────────────────────────────────────
// Forcing structured output is the actual fix for "a subagent's free-text
// summary read like an approval but the work was truncated" — a schema
// can't be skimmed past the way a paragraph can.

const PLAN_SCHEMA = {
  type: 'object',
  required: ['files', 'plan'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    plan: { type: 'string' },
    risks: { type: 'string' },
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['worktreePath', 'branch', 'filesChanged', 'summary'],
  properties: {
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['blocking', 'findings'],
  properties: {
    blocking: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          file: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
}

const BUILD_GATE_SCHEMA = {
  type: 'object',
  required: ['passed'],
  properties: { passed: { type: 'boolean' }, error: { type: 'string' } },
}

const LAND_SCHEMA = {
  type: 'object',
  required: ['pushed'],
  properties: {
    pushed: { type: 'boolean' },
    commitHash: { type: 'string' },
    error: { type: 'string' },
  },
}

const NOTION_SCHEMA = {
  type: 'object',
  required: ['written', 'verified'],
  properties: { written: { type: 'boolean' }, verified: { type: 'boolean' } },
}

const DEPLOY_SCHEMA = {
  type: 'object',
  required: ['live'],
  properties: { live: { type: 'boolean' } },
}

// ── args ─────────────────────────────────────────────────────────────────
// args = {
//   task: {
//     name, intent: 'implement'|'debug', riskLevel: 'low'|'medium'|'high', description,
//     multiFile: boolean,   // run a Planner pass first [ADDRESSED: 2]
//   },
//   maxAttempts: number,    // default 2 [ADDRESSED: 3]
//   notion: {
//     dailyLogPageId,               // optional — Daily Log Done-Today write
//     backlogRowId, completionDate, // optional — Backlog Status+Date write [ADDRESSED: 1]
//   },
// }
// completionDate must be passed in (YYYY-MM-DD, the day the work actually
// lands) — Workflow scripts can't call Date.now()/new Date() themselves,
// so the caller (which can read the real clock) supplies it.

const task = args && args.task
if (!task || !task.name) {
  throw new Error('carigaji-verify-commit requires args.task.{name,intent,riskLevel,description}')
}
const notionCfg = args.notion || {}
const MAX_ATTEMPTS = args.maxAttempts || DEFAULT_MAX_ATTEMPTS

log(`Landing agenda item: ${task.name} (${task.intent}, risk=${task.riskLevel}, maxAttempts=${MAX_ATTEMPTS})`)

// ── Plan (only for multi-file tasks) [ADDRESSED: 2] ────────────────────────
let plan = null
if (task.multiFile) {
  phase('Plan')
  plan = await agent(
    `Task: ${task.name}\nDescription: ${task.description}\n` +
      `Working directory: /Users/jiayutee/Dev/Projects/CariGaji\n` +
      `Produce a scope plan for this multi-file change: which files need to change and why, plus any risks.`,
    { agentType: 'planner', schema: PLAN_SCHEMA, phase: 'Plan' }
  )
}

// ── Implement / Verify / Build Gate, retried with real context [ADDRESSED: 3] ─
// Bounded, not open-ended (that's the cost tradeoff in disadvantage 4) —
// but each retry carries the SPECIFIC prior failure forward, so it's a
// second real attempt at the actual problem, not a blind redo.
const implementer = task.intent === 'debug' ? 'debugger' : 'feature-dev'
let attempt = 0
let impl = null
let allFindings = []
let priorFailure = null
let succeeded = false

while (attempt < MAX_ATTEMPTS && !succeeded) {
  attempt++
  log(`Attempt ${attempt}/${MAX_ATTEMPTS}`)

  phase('Implement')
  const planContext = plan
    ? `\nPlan from the planning pass — files: ${plan.files.join(', ')}. Plan: ${plan.plan}` +
      `${plan.risks ? '. Risks: ' + plan.risks : ''}`
    : ''
  const failureContext = priorFailure
    ? `\nThe previous attempt failed at "${priorFailure.stage}": ${priorFailure.reason}. ` +
      `Fix that specific problem — do not just redo the same thing.`
    : ''
  impl = await agent(
    `Task: ${task.name}\nDescription: ${task.description}${planContext}${failureContext}\n` +
      `Working directory: /Users/jiayutee/Dev/Projects/CariGaji\n` +
      `Implement this change (if intent is debug: isolate root cause, then fix it). ` +
      `Never hardcode hex colors — use BRAND theme tokens. ` +
      `Return worktreePath (your cwd), branch (your current branch), filesChanged, and a one-paragraph summary.`,
    { agentType: implementer, isolation: 'worktree', schema: IMPLEMENT_SCHEMA, phase: 'Implement' }
  )

  if (!impl) {
    priorFailure = { stage: 'implement', reason: 'implementer agent produced no result' }
    continue
  }

  phase('Verify')
  const reviewerTypes = ['code-reviewer']
  if (task.riskLevel !== 'low') reviewerTypes.push('security-reviewer')

  const reviews = (
    await parallel(
      reviewerTypes.map((r) => () =>
        agent(
          `Review the diff in worktree ${impl.worktreePath} (branch ${impl.branch}) against main. ` +
            `Files changed: ${impl.filesChanged.join(', ')}. Context: ${task.description}\n` +
            `Set blocking=true only for a real correctness/security defect, not style nits.`,
          { agentType: r, schema: REVIEW_SCHEMA, phase: 'Verify', label: `verify:${r}:attempt${attempt}` }
        )
      )
    )
  ).filter(Boolean)

  allFindings = reviews.flatMap((r) => r.findings || [])
  if (reviews.some((r) => r.blocking)) {
    priorFailure = { stage: 'verify', reason: 'reviewer blocked', findings: allFindings }
    continue
  }

  phase('Build Gate')
  const gate = await agent(
    `cd ${impl.worktreePath} && ${BUILD_GATE_CMD}. ` +
      `Report passed=true only if that command exits 0. On failure, capture the error text verbatim.`,
    { agentType: 'test-runner', schema: BUILD_GATE_SCHEMA, phase: 'Build Gate' }
  )

  if (!gate || !gate.passed) {
    priorFailure = { stage: 'build-gate', reason: gate ? gate.error : 'no result' }
    continue
  }

  succeeded = true
}

if (!succeeded) {
  log(`Gave up after ${attempt} attempt(s) at "${priorFailure.stage}": ${priorFailure.reason}`)
  return {
    landed: false,
    stage: priorFailure.stage,
    reason: priorFailure.reason,
    findings: priorFailure.findings || allFindings,
    attempts: attempt,
    worktreePath: impl ? impl.worktreePath : undefined,
  }
}

// ── Land: merge the worktree branch into main and push ────────────────────
phase('Land')
const land = await agent(
  `In /Users/jiayutee/Dev/Projects/CariGaji: git fetch origin, then merge branch ${impl.branch} ` +
    `(from worktree ${impl.worktreePath}) into main with a commit message describing "${task.name}", ` +
    `including the standard Co-Authored-By trailer. Push origin main. Only after the push succeeds, ` +
    `remove the worktree (git worktree remove ${impl.worktreePath}). ` +
    `Report pushed=true with the resulting commit hash, or pushed=false with the error — ` +
    `do not remove the worktree if the push failed.`,
  { agentType: 'feature-dev', schema: LAND_SCHEMA, phase: 'Land' }
)

if (!land || !land.pushed) {
  log(`Push failed: ${land ? land.error : 'no result'}`)
  return { landed: false, stage: 'land', reason: land ? land.error : 'no result', attempts: attempt, worktreePath: impl.worktreePath }
}

log(`Pushed ${land.commitHash}`)

// ── Notion: Daily Log write, then Backlog Status+Date write ────────────────
// Both writes follow the same shape: write, then re-fetch to prove it
// actually persisted, then retry once if it didn't. Never trust the write
// call's own success response as proof — that trust is what silently no-op'd
// 4 times in the current implementation.
phase('Notion')

let dailyLog = { written: false, verified: false }
if (notionCfg.dailyLogPageId) {
  dailyLog = await agent(
    `Append to today's Daily Log page (id ${notionCfg.dailyLogPageId}): Done Today gets ` +
      `"${task.name} — commit ${land.commitHash}". ${NOTION_WRITE_RULES} ` +
      `Then re-fetch the page and confirm "${land.commitHash}" now appears in its Commits property. ` +
      `written=true only means the write call succeeded; verified=true only if the re-fetch shows the hash.`,
    { schema: NOTION_SCHEMA, phase: 'Notion', label: 'daily-log' }
  )
  if (!dailyLog || !dailyLog.verified) {
    log('Daily Log write did not verify on first attempt — retrying once.')
    dailyLog = await agent(
      `Re-fetch today's Daily Log page (id ${notionCfg.dailyLogPageId}). If "${land.commitHash}" is still ` +
        `missing from its Commits property, write it (concatenating, never overwriting) and re-fetch once ` +
        `more to confirm.`,
      { schema: NOTION_SCHEMA, phase: 'Notion', label: 'daily-log-retry' }
    )
  }
} else {
  log('No Daily Log page id supplied — skipping Daily Log write.')
}

// [ADDRESSED: 1] The rule the first draft left out — Status and Date of
// Completion move together, in ONE call, always re-verified together. This
// is the specific gap that produced a measured 38% defect rate (45 of 118
// Done rows missing a completion date) when it was enforced only by prose.
let backlog = { written: false, verified: false }
if (notionCfg.backlogRowId) {
  if (!notionCfg.completionDate) {
    log('backlogRowId given without completionDate — skipping the Backlog write rather than guessing a date.')
  } else {
    backlog = await agent(
      `Update Feature Backlog row ${notionCfg.backlogRowId} in ONE notion-update-page call: set Status to ` +
        `"Done" AND Date of Completion to "${notionCfg.completionDate}" together — never one without the ` +
        `other. ${NOTION_WRITE_RULES} Then re-fetch the row and confirm BOTH fields actually took. ` +
        `written=true only if the call succeeded; verified=true only if the re-fetch shows BOTH ` +
        `Status=Done and Date of Completion=${notionCfg.completionDate}.`,
      { schema: NOTION_SCHEMA, phase: 'Notion', label: 'backlog-status-date' }
    )
    if (!backlog || !backlog.verified) {
      log('Backlog Status+Date write did not verify on first attempt — retrying once.')
      backlog = await agent(
        `Re-fetch Feature Backlog row ${notionCfg.backlogRowId}. If Status and Date of Completion aren't ` +
          `BOTH set correctly, write both together again (never one alone) and re-fetch once more to confirm.`,
        { schema: NOTION_SCHEMA, phase: 'Notion', label: 'backlog-status-date-retry' }
      )
    }
  }
}

// ── Deploy check ───────────────────────────────────────────────────────────
phase('Deploy')
const deploy = await agent(
  `Sleep 60 seconds, then run: gh api -X POST repos/jiayutee/CariGaji/pages/builds. ` +
    `Then curl -s https://jiayutee.github.io/CariGaji/ and confirm it reflects this change: ` +
    `${impl.summary}. Report live=true only if you can actually confirm the live site changed.`,
  { schema: DEPLOY_SCHEMA, phase: 'Deploy' }
)

return {
  landed: true,
  commitHash: land.commitHash,
  attempts: attempt,
  notionVerified: !!(dailyLog && dailyLog.verified),
  backlogVerified: notionCfg.backlogRowId ? !!(backlog && backlog.verified) : null,
  deployLive: !!(deploy && deploy.live),
  findings: allFindings,
}
