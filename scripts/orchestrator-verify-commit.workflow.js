// Workflow script — the "verify/commit slice" of the orchestrator loop.
//
// NOT wired into scripts/orchestrator-runner.sh yet. This is a draft: it
// replaces STEP 4-7 of SKILL.md (execute -> build gate -> commit/push ->
// Notion update -> deploy) with deterministic control flow and
// schema-validated agent output, for exactly the class of bug that keeps
// recurring when those steps are prose instructions an LLM has to remember
// to follow every 2-hour cycle: a silent no-op Notion write, a turn-limit
// truncation misread as a clean review, a build gate that gets skipped.
//
// STEP 0-3 (Telegram intake, ambiguity handling, agenda pick, risk
// classification) stay OUTSIDE this script on purpose -- those need an
// LLM's judgment on unstructured input, not a fixed pipeline shape. The
// top-level session would do STEP 0-3 as today, then call:
//
//   Workflow({ scriptPath: 'scripts/orchestrator-verify-commit.workflow.js',
//              args: { task: {...}, notion: { dailyLogPageId } } })
//
// Per this session's own tooling rules, running Workflow requires the
// owner's explicit opt-in (or ultracode mode) — this file is a draft for
// review, nothing here has been executed.

export const meta = {
  name: 'carigaji-verify-commit',
  description: 'Land one agenda item: implement -> verify -> build-gate -> merge/push -> Notion confirm -> deploy-check',
  phases: [
    { title: 'Implement', detail: 'feature-dev or debugger, isolated in a worktree' },
    { title: 'Verify', detail: 'code-reviewer (+ security-reviewer if risk >= medium) on the diff' },
    { title: 'Build Gate', detail: 'esbuild syntax check before anything lands on main' },
    { title: 'Land', detail: 'merge the worktree branch into main and push' },
    { title: 'Notion', detail: 'write Done Today + commit hash, re-fetch to confirm it persisted' },
    { title: 'Deploy', detail: 'force a Pages publish and confirm the live site changed' },
  ],
}

// ── schemas ────────────────────────────────────────────────────────────────
// Forcing structured output is the actual fix for "a subagent's free-text
// summary read like an approval but the work was truncated" — a schema
// can't be skimmed past the way a paragraph can.

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
//   task: { name, intent: 'implement'|'debug', riskLevel: 'low'|'medium'|'high', description },
//   notion: { dailyLogPageId },   // optional — skip the Notion phase if absent
// }

const task = args && args.task
if (!task || !task.name) {
  throw new Error('carigaji-verify-commit requires args.task.{name,intent,riskLevel,description}')
}
const notionPageId = args.notion && args.notion.dailyLogPageId

log(`Landing agenda item: ${task.name} (${task.intent}, risk=${task.riskLevel})`)

// ── Implement ────────────────────────────────────────────────────────────
phase('Implement')
const implementer = task.intent === 'debug' ? 'debugger' : 'feature-dev'
const impl = await agent(
  `Task: ${task.name}\nDescription: ${task.description}\n` +
    `Working directory: /Users/jiayutee/Dev/Projects/CariGaji\n` +
    `Implement this change (if intent is debug: isolate root cause, then fix it). ` +
    `Never hardcode hex colors — use BRAND theme tokens. ` +
    `Return worktreePath (your cwd), branch (your current branch), filesChanged, and a one-paragraph summary.`,
  { agentType: implementer, isolation: 'worktree', schema: IMPLEMENT_SCHEMA, phase: 'Implement' }
)

if (!impl) {
  return { landed: false, stage: 'implement', reason: 'implementer agent produced no result' }
}

// ── Verify (barrier: need every reviewer's verdict before deciding) ────────
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
        { agentType: r, schema: REVIEW_SCHEMA, phase: 'Verify', label: `verify:${r}` }
      )
    )
  )
).filter(Boolean)

const allFindings = reviews.flatMap((r) => r.findings || [])
const blocked = reviews.some((r) => r.blocking)

if (blocked) {
  log('Blocked by reviewer findings — no commit this cycle.')
  return { landed: false, stage: 'verify', reason: 'reviewer blocked', findings: allFindings, worktreePath: impl.worktreePath }
}

// ── Build gate ───────────────────────────────────────────────────────────
phase('Build Gate')
const gate = await agent(
  `cd ${impl.worktreePath} && npx esbuild carigaji-app.jsx --bundle=false --platform=browser > /dev/null. ` +
    `Report passed=true only if that command exits 0. On failure, capture the error text verbatim.`,
  { agentType: 'test-runner', schema: BUILD_GATE_SCHEMA, phase: 'Build Gate' }
)

if (!gate || !gate.passed) {
  log(`Build gate failed: ${gate ? gate.error : 'no result'}`)
  return { landed: false, stage: 'build-gate', reason: gate ? gate.error : 'no result', worktreePath: impl.worktreePath }
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
  return { landed: false, stage: 'land', reason: land ? land.error : 'no result', worktreePath: impl.worktreePath }
}

log(`Pushed ${land.commitHash}`)

// ── Notion: write, then re-fetch to confirm it actually persisted ─────────
phase('Notion')
let notion = { written: false, verified: false }
if (notionPageId) {
  notion = await agent(
    `Append to today's Daily Log page (id ${notionPageId}): Done Today gets ` +
      `"${task.name} — commit ${land.commitHash}". Fetch and concatenate the existing field first — ` +
      `never overwrite it. Then re-fetch the page and confirm "${land.commitHash}" now appears in its ` +
      `Commits property. written=true only means the write call succeeded; verified=true only if the ` +
      `re-fetch actually shows the hash.`,
    { schema: NOTION_SCHEMA, phase: 'Notion' }
  )
  if (!notion || !notion.verified) {
    log('Notion write did not verify on first attempt — retrying once.')
    notion = await agent(
      `Re-fetch today's Daily Log page (id ${notionPageId}). If "${land.commitHash}" is still missing ` +
        `from its Commits property, write it (concatenating, never overwriting) and re-fetch once more ` +
        `to confirm.`,
      { schema: NOTION_SCHEMA, phase: 'Notion', label: 'notion-retry' }
    )
  }
  if (!notion || !notion.verified) {
    log('Notion write still unverified after retry — flagging rather than silently continuing.')
  }
} else {
  log('No Notion page id supplied — skipping Daily Log update.')
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
  notionVerified: !!(notion && notion.verified),
  deployLive: !!(deploy && deploy.live),
  findings: allFindings,
}
