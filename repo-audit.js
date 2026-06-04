export const meta = {
  name: 'repo-audit',
  description: 'Reusable production-readiness audit: profile any repo, run universal + auto-detected domain lenses + executed tools, verify by oracle strength (execution where falsifiable, stronger-tier reasoning where judgment), provenance-weight, and triage into a go/no-go scorecard',
  whenToUse: 'Point at any repo for a verified, triaged production-readiness scorecard. args:{repoRoot, domainLenses?, fanout?, skipLenses?, workerModel?, verifierModel?, trustLevel?, executeVerification?, hierarchicalSynthesis?}. fanout: auto (default — picks economy vs standard by repo size) | quick | economy | standard | thorough. trustLevel: trusted (default; runs analyzers/tests) | untrusted (inspection only, no code execution — REQUIRED for untrusted repos; run the auditor itself in a sandbox if executing). executeVerification + hierarchicalSynthesis are opt-in/experimental (need a sandbox / large-audit validation).',
  phases: [
    { title: 'Profile', detail: 'discover language, kind, domain, subsystems, deps, test command, applicable domain lenses' },
    { title: 'Recon', detail: 'deep-map each discovered subsystem' },
    { title: 'Audit', detail: 'universal dimensions: security, quality, correctness, deps, tests' },
    { title: 'Sweep', detail: 'unframed open-ended review per subsystem — maximize recall' },
    { title: 'Critic', detail: 'completeness critic hunts for what every prior pass missed' },
    { title: 'BizLogic', detail: 'intent-vs-implementation: does each feature/control do what it claims' },
    { title: 'Improve', detail: 'opportunities incl. reductive (delete/simplify), anti-additive-biased' },
    { title: 'Readiness', detail: 'NFR lenses: resilience, auditability, ops/cost + selected domain lenses' },
    { title: 'Seam', detail: 'cross-subsystem interface code — producer/consumer contracts, trust boundaries' },
    { title: 'GroundTruth', detail: 'execute language-appropriate analyzers (gated by trustLevel)' },
    { title: 'Verify', detail: 'route by oracle: execution where falsifiable, stronger-tier reasoning where judgment; provenance-stamped, never silent-refuted' },
    { title: 'Plan', detail: 'recalibrate severity, dedup, triage, provenance-weighted GREEN/YELLOW/RED scorecard' },
  ],
}

// ===========================================================================
// CHANGELOG v2 — verification moved from same-model inspection toward
// execution-grounded observation + provenance weighting.
//   ACTIVE: provenance verdicts, verify router + stronger-tier judgment verify,
//           semantic lens selection, seam pass, severity recalibration, dual
//           tracks, ID validation, trustLevel gate, retry de-amplification.
//   OFF by default (need sandbox / large-audit validation):
//           executeVerification (execution oracle + repro-coverage guard),
//           hierarchicalSynthesis. Both wired and documented; enable when you
//           can run the auditor containerized and confirm behavior.
//   DEFERRED (cost): cross-model verification — run manually only on the few
//           RED-gating judgment findings as a final adjudication pass.
//
// CHANGELOG v2.1 — calibration + cost, from the hateoas-agent validation +
// execution-grounded meta-audit (2026-06-04):
//   - severity recalibration now DEFAULTS DOWN / justifies up (meta-audit found
//     ~39 findings over-rated vs ~4 under-rated; maintainability/CI/latent =>
//     capped at medium unless a concrete trigger+blast-radius earns higher).
//   - fanout defaults to 'auto': profile reports source_file_count; repos over
//     AUTO_BATCH_FILES (30) use batched verification (~5-8x fewer verifier
//     agents) to cut cost and rate-limit pressure. Force per-finding with
//     fanout:'standard'.
//   NOTE (environmental, not engine): long wall-clock on the first validation
//     run was overnight host SLEEP suspending the process — run awake / on AC /
//     `caffeinate -dimsu`. Verdict logic itself validated execution-grounded.
//
// CHANGELOG v2.2 — two-gate execution verification (2026-06-04):
//   Execution proves a behavior MANIFESTS; it cannot prove the behavior is a
//   DEFECT (e.g. CancelledError tearing down siblings reproduces, yet is
//   correct cooperative cancellation). The execution verifier now runs a second
//   gate: is_genuine_defect + fix_is_sound. A finding that reproduces but is
//   correct-by-design is execution-REFUTED ("mechanism real, not a defect"),
//   not execution-confirmed. Prevents execution-confirmation from rubber-
//   stamping correct-by-design behavior at the strongest provenance tier.
//
// CHANGELOG v2.3 — safety, calibration, cost, hygiene (2026-06-04):
//   - read-only enforcement: hooks/readonly-guard.py (PreToolUse) blocks writes
//     to the repo under audit when REPO_AUDIT_GUARD is set (the agent() API has
//     no per-agent tool denial, so enforcement lives in a harness hook).
//   - sandboxed:true => executeVerification on by default (script can't detect a
//     sandbox; caller asserts it). Explicit executeVerification:false still wins.
//   - reasoning verifier now STEELMANS before refuting (caught the READ-297
//     class: refuting a real bug on a shallow "the library handles it" read).
//   - maxOutputTokens / turn-budget guard: skips not-yet-started passes once the
//     cap is hit (fleet-level only — no per-agent ceiling in the API).
//   - pre-flight hygiene: profiler reports git_status (warns on stale checkout —
//     we once audited month-old code) + a keep-host-awake note on large repos.
//
// CHANGELOG v2.4 — make the rigor reachable under auto/economy fanout (2026-06-04):
//   v2.1's auto-fanout routes most real repos to BATCHED verify, which bypassed
//   verifyOne entirely — so v2.2's execution two-gate, v2.3's steelman, and the
//   tier-asymmetry never ran for the repos that most need them. Fixed:
//   - verifyMany batched mode is now TWO-STAGE: cheap batched inspection triages
//     all findings (cost control on the bulk), then scorecard-gating survivors
//     (batch-confirmed AND (high/critical OR falsifiable-with-execution-on)) are
//     escalated to verifyOne (execution two-gate + steelman + tier-asymmetry).
//   - gate-2 (is_genuine_defect/fix_is_sound) — the subtlest call — now runs on
//     verifierModel for high-severity execution verdicts (was always workerModel)
//     and the execution prompt steelmans the defect case first. (meta-audit.js
//     gets the same high-stakes->stronger-model routing for its adjudicator.)
// ===========================================================================

// ---------------------------------------------------------------------------
// Config. args may arrive as an object, a JSON-encoded string, or a bare path.
// ---------------------------------------------------------------------------
let A = args
if (typeof A === 'string') {
  try { const parsed = JSON.parse(A); A = (parsed && typeof parsed === 'object') ? parsed : { repoRoot: A } }
  catch { A = { repoRoot: A } }
}
A = A || {}
if (!A.repoRoot) {
  throw new Error('repo-audit requires args.repoRoot. Example: Workflow({name:"repo-audit", args:{repoRoot:"/abs/path/to/repo"}})')
}
const cfg = {
  repoRoot: A.repoRoot,
  domainLenses: Array.isArray(A.domainLenses) ? A.domainLenses : [],   // explicit override; [] => profile picks
  skipLenses: Array.isArray(A.skipLenses) ? A.skipLenses : [],
  fanout: A.fanout || 'auto',                                           // 'auto' | 'quick' | 'economy' | 'standard' | 'thorough' (auto picks economy vs standard by repo size after profiling)
  workerModel: A.workerModel || 'sonnet',                               // finders + falsifiable/cheap verify
  verifierModel: A.verifierModel || 'opus',                             // judgment-finding verify (gated by severity)
  trustLevel: A.trustLevel === 'untrusted' ? 'untrusted' : 'trusted',   // untrusted => no code execution at all
  sandboxed: A.sandboxed === true,                                      // caller asserts the auditor runs in a sandbox/disposable checkout
  // execution-grounded verify. The script cannot detect a sandbox itself, so it
  // stays opt-in — but asserting sandboxed:true turns it on by default (now safe:
  // v2.2's gate-2 stops it rubber-stamping correct-by-design behavior). Explicit
  // executeVerification:false always wins.
  executeVerification: A.executeVerification === true || (A.executeVerification !== false && A.sandboxed === true && A.trustLevel !== 'untrusted'),
  hierarchicalSynthesis: A.hierarchicalSynthesis === true,              // per-category sub-synthesis (experimental)
  maxOutputTokens: Number(A.maxOutputTokens) || null,                   // hard cap; also respects the turn-level budget if set
}
const runBreadth = cfg.fanout !== 'quick'
const verifyVotes = cfg.fanout === 'thorough' ? 3 : 1
// 'auto' resolves after profiling (large repos => batched verify to control cost/rate-limit pressure).
// Until then it behaves per-finding; the AUTO_BATCH_FILES threshold flips it once we know the file count.
let verifyMode = cfg.fanout === 'economy' ? 'batched' : 'per-finding'
const AUTO_BATCH_FILES = 30

// Budget guard (#4). Bounds TOTAL output-token spend: skips not-yet-started passes
// once the cap is hit so synthesis still runs on what was collected. Respects an
// explicit maxOutputTokens arg and/or the turn-level budget directive.
// LIMITATION: agent() exposes no PER-AGENT token ceiling, so a single runaway
// agent cannot be hard-capped here — this is a fleet-level bound only.
const _budget = (typeof budget !== 'undefined') ? budget : null
const tokenCap = cfg.maxOutputTokens || (_budget && _budget.total) || null
function budgetExceeded() {
  if (!tokenCap || !_budget || !_budget.spent) return false
  try { return _budget.spent() >= tokenCap } catch { return false }
}
const VERIFY_BATCH = 8
const canExecute = cfg.trustLevel === 'trusted'                         // GroundTruth tools + execution verify
const doExecVerify = cfg.executeVerification && canExecute              // execution oracle active?
const ROOT = cfg.repoRoot
const base = p => (p || '').split('/').pop()
const skip = key => cfg.skipLenses.includes(key)
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const sevHigh = f => (SEV_RANK[f.severity] ?? 3) <= 1

// Retry wrapper for "find"-type agents. Attempts kept LOW (2) to avoid amplifying a saturated endpoint
// under heavy parallelism (no timer primitive => no backoff; the framework concurrency cap is the real
// backpressure). Verifiers don't use this — a missing verdict marks verdict.unverified, never refuted.
async function withRetry(fn, attempts = 2) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) { lastErr = e }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const PROFILE_SCHEMA = {
  type: 'object',
  required: ['language', 'kind', 'domain', 'subsystems'],
  properties: {
    language: { type: 'string' },
    build_system: { type: 'string' },
    test_command: { type: 'string' },
    kind: { type: 'string', description: 'library | CLI | server | MCP-server | web-app | data-pipeline | other' },
    domain: { type: 'string', description: 'what this software is for, in plain words' },
    subsystems: {
      type: 'array',
      description: '3-6 cohesive units the code naturally decomposes into',
      items: { type: 'object', required: ['key', 'desc'], properties: { key: { type: 'string' }, desc: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } },
    },
    external_deps: { type: 'array', items: { type: 'string' } },
    largest_files: { type: 'array', items: { type: 'string' } },
    source_file_count: { type: 'integer', description: 'approximate count of first-party source files (exclude vendored/generated/deps) — used to size the audit' },
    src_dirs: { type: 'array', items: { type: 'string' }, description: 'top-level source dirs analyzers should target (e.g. src, lib)' },
    selected_domain_lenses: { type: 'array', items: { type: 'string' }, description: 'lens keys from the provided menu that genuinely apply to this repo' },
    git_status: { type: 'string', enum: ['current', 'behind-remote', 'dirty', 'behind-and-dirty', 'not-a-git-repo', 'unknown'], description: 'is the checkout CURRENT? run `git fetch -q` then `git status -sb`/`git rev-list` — behind-remote means you may be auditing stale code' },
  },
}

const MAP_SCHEMA = {
  type: 'object',
  required: ['subsystem', 'purpose', 'key_files', 'observations'],
  properties: {
    subsystem: { type: 'string' }, purpose: { type: 'string' },
    key_files: { type: 'array', items: { type: 'string' } },
    entry_points: { type: 'array', items: { type: 'string' } },
    external_io: { type: 'array', items: { type: 'string' } },
    observations: { type: 'array', items: { type: 'string' } },
  },
}

// Finders now self-classify each finding by oracle strength so verification can route it.
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'file', 'evidence', 'recommendation'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string', description: 'path:line' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
          effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
          verify_class: { type: 'string', enum: ['falsifiable', 'judgment'], description: 'falsifiable = a test/PoC/probe could confirm it at runtime; judgment = maintainability/methodology/architecture/absent-control' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['real', 'reasoning'],
  properties: { real: { type: 'boolean' }, reasoning: { type: 'string' }, severity_adjustment: { type: 'string' } },
}

// Execution-grounded verdict (used only when executeVerification is on, in a sandbox).
const EXEC_VERDICT_SCHEMA = {
  type: 'object',
  required: ['reasoning', 'reproduction', 'is_genuine_defect'],
  properties: {
    reasoning: { type: 'string' },
    // Gate 2: manifesting a behavior (reproduction below) is necessary but NOT
    // sufficient — a behavior can manifest yet be correct-by-design. Execution
    // settles whether it manifests; this judges whether manifesting is a DEFECT.
    is_genuine_defect: { type: 'boolean', description: 'GIVEN it manifests, is the behavior actually WRONG — not correct/intended (correct cancellation, documented tradeoff, defensive/fail-closed default)?' },
    fix_is_sound: { type: 'boolean', description: 'would the recommended fix avoid regressing a different correctness property (e.g. not swallow KeyboardInterrupt)?' },
    reproduction: {
      type: 'object',
      required: ['method', 'executed', 'observed'],
      properties: {
        method: { type: 'string', enum: ['test', 'exploit', 'benchmark', 'coverage', 'fault-injection', 'none'] },
        repro_code: { type: 'string' },
        executed: { type: 'boolean' },
        hit_cited_line: { type: 'boolean', description: 'did the repro provably exercise the cited file:line (coverage/instrumentation)?' },
        observed: { type: 'string', enum: ['confirmed', 'not-reproduced', 'inconclusive'] },
        output: { type: 'string', description: 'REAL run output — never invented' },
      },
    },
  },
}

const TRIAGE_ITEM = {
  type: 'object',
  required: ['id', 'dimension', 'title', 'file', 'verifier_verdict', 'severity', 'disposition', 'rationale'],
  properties: {
    id: { type: 'string' }, dimension: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' },
    verifier_verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
    provenance: { type: 'string', enum: ['execution-confirmed', 'execution-refuted', 'tool-reported', 'stronger-tier-agreed', 'single-model-inspection', 'unverified'] },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    disposition: { type: 'string', enum: ['fix-now', 'fix-soon', 'backlog', 'monitor', 'dismiss'] },
    rationale: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['executive_summary', 'scorecard', 'themes', 'triage', 'prioritized_actions', 'quick_wins'],
  properties: {
    executive_summary: { type: 'string' },
    scorecard: {
      type: 'array',
      description: 'One row per relevant category. verdict reflects provenance: execution-confirmed evidence can hard-RED; judgment/inspection-only criticals are "needs human confirmation", not auto-RED.',
      items: {
        type: 'object',
        required: ['category', 'verdict', 'bar_to_clear', 'blocking_findings'],
        properties: {
          category: { type: 'string' },
          verdict: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED', 'NEEDS-HUMAN', 'N/A'] },
          summary: { type: 'string' },
          bar_to_clear: { type: 'string' },
          blocking_findings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    themes: { type: 'array', items: { type: 'string' } },
    triage: { type: 'array', description: 'EVERY finding — confirmed, refuted, unverified. Merge duplicates.', items: TRIAGE_ITEM },
    prioritized_actions: {
      type: 'array', description: 'DEFECTS only, ranked by (severity × leverage)/effort.',
      items: { type: 'object', required: ['rank', 'action', 'rationale', 'severity', 'effort', 'files'], properties: { rank: { type: 'number' }, action: { type: 'string' }, rationale: { type: 'string' }, severity: { type: 'string' }, effort: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } },
    },
    opportunities: {
      type: 'array', description: 'IMPROVEMENTS (source=improvement) on their OWN scale, ranked separately from defects.',
      items: { type: 'object', required: ['rank', 'action', 'payoff', 'effort'], properties: { rank: { type: 'number' }, action: { type: 'string' }, payoff: { type: 'string' }, effort: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } },
    },
    quick_wins: { type: 'array', items: { type: 'string' } },
  },
}

const SUBSYNTH_SCHEMA = {
  type: 'object', required: ['category', 'verdict', 'summary', 'bar_to_clear', 'triage'],
  properties: {
    category: { type: 'string' },
    verdict: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED', 'NEEDS-HUMAN', 'N/A'] },
    summary: { type: 'string' }, bar_to_clear: { type: 'string' },
    triage: { type: 'array', items: TRIAGE_ITEM },
  },
}

// ---------------------------------------------------------------------------
// Domain lens registry (now selected semantically by the profile agent)
// ---------------------------------------------------------------------------
const DOMAIN_LENS_LIB = {
  forecasting: { expert: 'a forecasting & statistics expert (Tetlock/Brier/calibration literature)', prompt: `Evaluate whether the forecasting/statistical METHODOLOGY is sound — not whether the code runs, but whether the STATISTICS are valid: proper-scoring rules, calibration approach, aggregation/extremization, base-rate handling, effective-N/correlation. Flag methodological errors, unjustified heuristics, and code that is correct but whose METHOD is questionable.` },
  'mcp-server': { expert: 'an MCP (Model Context Protocol) reviewer', prompt: `Audit MCP-server correctness: tool/resource SCHEMA conformance, error-envelope handling (clean MCP error vs transport crash), stdio/SSE transport robustness, auth/permission boundaries, idempotency/side-effect safety, and whether tool descriptions match actual behavior.` },
  'agent-system': { expert: 'a multi-agent-systems reviewer', prompt: `Audit multi-agent orchestration: prompt/instruction integrity, message/protocol contracts, provenance of findings (can one agent silently absorb another's work), hook/gate enforcement, deadlock/convergence handling, and whether claimed rigor actually holds in the code paths.` },
  'hardware-io': { expert: 'an embedded / real-time systems reviewer', prompt: `Audit hardware/device I/O safety: serial/BLE/USB/GPIO command construction and bounds, connection lifecycle, timeouts and fail-safe states on command failure, blocking I/O on critical paths, and device state on a crash mid-command.` },
  'web-api': { expert: 'a web-API/backend reviewer', prompt: `Audit web-API concerns: input validation at the boundary, authn/authz per route, rate limiting, error responses that leak internals, status-code correctness, request/response contract stability.` },
  'data-pipeline': { expert: 'a data-engineering reviewer', prompt: `Audit data-pipeline concerns: idempotency/re-run safety, schema/contract validation between stages, partial-failure and backfill handling, data integrity under concurrency, silent data corruption paths.` },
}
const LENS_MENU = Object.entries(DOMAIN_LENS_LIB).map(([k, v]) => `- ${k}: ${v.expert}`).join('\n')
// Lexical fallback only if the profile agent picks nothing.
function autoDetectDomainLenses(profile) {
  const hay = `${profile.domain || ''} ${profile.kind || ''} ${(profile.external_deps || []).join(' ')}`.toLowerCase()
  const picks = []
  const add = k => { if (!picks.includes(k)) picks.push(k) }
  if (/forecast|predict|probab|calibrat|brier|bayes/.test(hay)) add('forecasting')
  if (/\bmcp\b|model context protocol|tool server/.test(hay)) add('mcp-server')
  if (/\bagents?\b|orchestrat|review team|multi-?agent/.test(hay)) add('agent-system')
  if (/robot|\bserial\b|\bble\b|bluetooth|gpio|hardware|firmware|\bdevices?\b|microbit|micro:bit/.test(hay)) add('hardware-io')
  if (/\bapi\b|\brest\b|fastapi|flask|express|endpoint|http server/.test(hay)) add('web-api')
  if (/etl|data pipeline|ingest|warehouse|batch job|dataframe/.test(hay)) add('data-pipeline')
  return picks
}

// ---------------------------------------------------------------------------
// Language-adaptive ground-truth toolchains. <SRC> => real src dirs (or '.').
// ---------------------------------------------------------------------------
const TOOLCHAINS = {
  python: ['ruff check <SRC> --output-format=concise', 'mypy <SRC> --ignore-missing-imports --no-error-summary', 'bandit -r <SRC> -ll -f screen', 'pip-audit', '<TEST>'],
  typescript: ['npx --no-install eslint .', 'npx --no-install tsc --noEmit', 'npm audit --omit=dev', '<TEST>'],
  javascript: ['npx --no-install eslint .', 'npm audit --omit=dev', '<TEST>'],
  rust: ['cargo clippy --quiet', 'cargo audit', 'cargo test --quiet'],
  go: ['go vet ./...', 'staticcheck ./...', 'govulncheck ./...', 'go test ./...'],
}

// ---------------------------------------------------------------------------
// Verification: route by oracle strength, stamp provenance, never silent-refute.
// ---------------------------------------------------------------------------
function mk(f, dimension, source, verdict) { return { ...f, dimension, source, verdict } }
function unverifiedVerdict(reason, extra) { return { real: false, unverified: true, provenance: 'unverified', reasoning: reason, votes: 0, real_votes: 0, severity_adjustment: null, ...(extra || {}) } }

function reasonVerifyPrompt(f, dimension, reviewerN) {
  return `Adversarially verify this audit finding for the repo at ${ROOT}${reviewerN ? ` (independent reviewer #${reviewerN})` : ''}. First STEELMAN it: state the finding's STRONGEST, most-likely-correct interpretation and the exact conditions under which it IS a real defect — THEN try to refute that strongest form. Read the actual code at the cited location before judging. Do not refute on a shallow or partial reading (e.g. "the library handles it") without checking the specific failure mode the finding claims (e.g. retry-EXHAUSTION, not just retry-exists). Default real=false if you cannot confirm it, or it is already handled.\n\n- REDUCTIVE recommendation (delete/inline/collapse): confirm removal is SAFE — search references; refute if it breaks callers/tests.\n- OPPORTUNITY/improvement: confirm the current state is as described and the payoff is credible; refute churn.\n- ABSENT-control claim: confirm the control truly does not exist anywhere in the repo.\n\nDimension: ${dimension}\nTitle: ${f.title}\nSeverity: ${f.severity}\nLocation: ${f.file}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}\n\nGenuine, material, and (if reductive) safe? Confirm or refute with code-grounded reasoning; adjust severity if warranted.`
}
function execVerifyPrompt(f, dimension) {
  return `EXECUTION-GROUNDED verification of a falsifiable finding in the repo at ${ROOT} (dimension: ${dimension}). You are in a sandbox; running code is permitted.\n\nFinding: ${f.title}\nLocation: ${f.file}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}\n\nWrite the MINIMAL reproduction that would manifest this issue (a failing test, an exploit PoC, a benchmark, a coverage probe, or fault injection). RUN it from the repo root and capture the REAL output — never invent output.\n\nREPRO-FAITHFULNESS (critical): confirm via coverage/instrumentation that your repro actually EXECUTES the cited file:line. If you cannot confirm it hit the cited code, set hit_cited_line=false and observed=inconclusive — do NOT report not-reproduced for a repro that never reached the code.\n\nGATE 2 (judgment; execution CANNOT settle this): manifesting is necessary but NOT sufficient. First STEELMAN it: state the strongest case that the manifested behavior IS a genuine defect, THEN adversarially test whether it is instead correct-by-design. A behavior can manifest and still be correct-by-design (correct cooperative cancellation, a documented tradeoff, a defensive/fail-closed default). Set is_genuine_defect=true ONLY if the manifested behavior is actually WRONG, not merely present; set fix_is_sound=false if the recommended fix would regress another property (e.g. catching BaseException swallows KeyboardInterrupt/SystemExit, or breaks a documented guarantee). If manifests-but-correct-by-design, say so in reasoning.\\n\\nReport: reasoning, is_genuine_defect, fix_is_sound, method, repro_code, executed, hit_cited_line, observed (confirmed only on actual manifestation | not-reproduced only if the code ran, hit the line, and the issue did NOT occur | inconclusive otherwise), and the real output.`
}

async function reasonVerify(f, dimension, model) {
  return (await parallel(Array.from({ length: verifyVotes }, (_, k) => () =>
    agent(reasonVerifyPrompt(f, dimension, verifyVotes > 1 ? k + 1 : 0),
      { label: `verify:${dimension}:${base(f.file)}${verifyVotes > 1 ? '#' + (k + 1) : ''}`, phase: 'Verify', model, schema: VERDICT_SCHEMA })
  ))).filter(Boolean)
}

// Verify one finding via the strongest available oracle for its class.
async function verifyOne(f, dimension, source) {
  const cls = f.verify_class === 'falsifiable' ? 'falsifiable' : 'judgment'

  // 1) Execution oracle (runtime is independent of model priors) — only when enabled + falsifiable.
  if (doExecVerify && cls === 'falsifiable') {
    try {
      // Gate-2 ("manifests but correct-by-design") is the subtlest call in the verdict, so for
      // high-severity findings run the whole execution adjudication on the stronger model.
      const execModel = (sevHigh(f) && cfg.verifierModel !== cfg.workerModel) ? cfg.verifierModel : cfg.workerModel
      const ex = await agent(execVerifyPrompt(f, dimension), { label: `exec:${dimension}:${base(f.file)}`, phase: 'Verify', model: execModel, schema: EXEC_VERDICT_SCHEMA })
      const rep = ex && ex.reproduction
      if (rep && rep.executed) {
        if (rep.observed === 'confirmed' && rep.hit_cited_line !== false) {
          // Gate 2: manifesting is not the same as being a defect. A behavior that
          // reproduces but is correct-by-design (e.g. correct cancellation) is REFUTED.
          if (ex.is_genuine_defect === false)
            return mk(f, dimension, source, { real: false, unverified: false, provenance: 'execution-refuted', reasoning: (ex.reasoning || 'manifests but correct-by-design') + ' [reproduced at runtime but judged correct-by-design, not a defect]', votes: 1, real_votes: 0, severity_adjustment: null, reproduction: rep })
          return mk(f, dimension, source, { real: true, unverified: false, provenance: 'execution-confirmed', reasoning: ex.reasoning || 'reproduced at runtime and judged a genuine defect', votes: 1, real_votes: 1, severity_adjustment: null, reproduction: rep })
        }
        if (rep.observed === 'not-reproduced' && rep.hit_cited_line === true)
          return mk(f, dimension, source, { real: false, unverified: false, provenance: 'execution-refuted', reasoning: ex.reasoning || 'did not manifest though the cited line ran', votes: 1, real_votes: 0, severity_adjustment: null, reproduction: rep })
        // inconclusive OR not-reproduced-but-line-not-hit => UNVERIFIED (never silent-refute a real bug behind a bad repro)
        return mk(f, dimension, source, unverifiedVerdict('UNVERIFIED — execution inconclusive or repro did not exercise the cited line; treat as unconfirmed, not refuted', { reproduction: rep }))
      }
    } catch (e) { /* fall through to reasoning */ }
  }

  // 2) Reasoning oracle. Tier-asymmetry: stronger model verifies high-severity JUDGMENT findings.
  const useStronger = cls === 'judgment' && sevHigh(f) && cfg.verifierModel !== cfg.workerModel
  const model = useStronger ? cfg.verifierModel : cfg.workerModel
  const votes = await reasonVerify(f, dimension, model)
  const realCount = votes.filter(v => v.real).length
  const unverified = votes.length === 0
  const real = unverified ? false : realCount >= Math.ceil(votes.length / 2)
  const provenance = unverified ? 'unverified' : (useStronger ? 'stronger-tier-agreed' : 'single-model-inspection')
  const execNote = (cls === 'falsifiable' && !doExecVerify) ? ' [falsifiable — would benefit from execution verification (enable executeVerification in a sandbox)]' : ''
  return mk(f, dimension, source, {
    real, unverified, provenance,
    reasoning: (votes.map(v => v.reasoning).join(' || ') || 'UNVERIFIED — verifier produced no verdict; treat as unconfirmed, not refuted') + execNote,
    votes: votes.length, real_votes: realCount,
    severity_adjustment: votes.map(v => v.severity_adjustment).filter(Boolean).join('; ') || null,
  })
}

// Economy: one cheap inspection verifier per batch (no router/execution/tier-asymmetry by design).
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
const BATCH_VERDICT_SCHEMA = {
  type: 'object', required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', required: ['index', 'real', 'reasoning'], properties: { index: { type: 'number' }, real: { type: 'boolean' }, reasoning: { type: 'string' }, severity_adjustment: { type: 'string' } } } } },
}
function batchVerifyPrompt(batch, dimension) {
  const list = batch.map((f, i) => `[${i}] title: ${f.title}\n    severity: ${f.severity}\n    file: ${f.file}\n    evidence: ${f.evidence}\n    recommendation: ${f.recommendation}`).join('\n')
  return `Adversarially verify these ${batch.length} findings for the repo at ${ROOT} (dimension: ${dimension}). For EACH, read the cited code; real=true ONLY if you confirm a genuine, material issue; default real=false if unconfirmable. Return EXACTLY one verdict per finding keyed by [index] 0..${batch.length - 1}.\n\n${list}`
}
async function verifyMany(findings, dimension, source) {
  if (!findings.length) return []
  // per-finding mode: every finding gets the full oracle (execution two-gate / steelman / tier-asymmetry).
  if (verifyMode !== 'batched') {
    return await parallel(findings.map(f => () =>
      verifyOne(f, dimension, source).catch(() => mk(f, dimension, source, unverifiedVerdict('UNVERIFIED — verifier threw; treat as unconfirmed, not refuted')))
    ))
  }
  // batched mode: TWO-STAGE. Stage A = cheap batched inspection triages ALL findings (cost control
  // on the bulk). Stage B = escalate the scorecard-gating survivors to verifyOne (execution two-gate
  // + steelman + tier-asymmetry) so auto/economy fanout does not route real findings AROUND the rigor.
  const batches = chunk(findings, VERIFY_BATCH)
  const maps = await parallel(batches.map((b, bi) => () =>
    agent(batchVerifyPrompt(b, dimension), { label: `verify:${dimension}#b${bi + 1}`, phase: 'Verify', model: cfg.workerModel, schema: BATCH_VERDICT_SCHEMA })
      .then(r => (r?.verdicts || []).reduce((m, v) => { m[v.index] = v; return m }, {}))
      .catch((e) => { log(`WARN: verify batch ${bi + 1} (${dimension}) failed — findings UNVERIFIED: ${e?.message || e}`); return {} })
  ))
  const triaged = findings.map((f, i) => {
    const v = (maps[Math.floor(i / VERIFY_BATCH)] || {})[i % VERIFY_BATCH]
    const verdict = v
      ? { real: !!v.real, unverified: false, provenance: 'single-model-inspection', reasoning: v.reasoning, votes: 1, real_votes: v.real ? 1 : 0, severity_adjustment: v.severity_adjustment || null }
      : unverifiedVerdict('UNVERIFIED — no verdict for this finding in batch (failed/missing index); treat as unconfirmed, not refuted')
    return mk(f, dimension, source, verdict)
  })
  // Escalate a batch-CONFIRMED finding when it gates the scorecard: high/critical severity (drives the
  // verdict), or falsifiable AND execution is enabled (the case the execution oracle can settle). Bulk
  // low/medium judgment findings keep the cheap batch verdict — that is where the cost savings live.
  const gates = t => t.verdict?.real && !t.verdict?.unverified && (sevHigh(t) || (t.verify_class === 'falsifiable' && doExecVerify))
  const nEsc = triaged.filter(gates).length
  if (nEsc) log(`Verify(${dimension}): batched ${triaged.length}; escalating ${nEsc} scorecard-gating finding(s) to the per-finding oracle.`)
  return await parallel(triaged.map(t => () =>
    gates(t) ? verifyOne(t, t.dimension, t.source).catch(() => t) : t
  ))
}

async function lensPass(items, phaseName, findPromptFn, dimOf, sourceOf) {
  let res
  try {
    res = await pipeline(
      items,
      it => withRetry(() => agent(findPromptFn(it), { label: `${phaseName.toLowerCase()}:${it.key || String(it)}`, phase: phaseName, model: cfg.workerModel, schema: FINDINGS_SCHEMA })),
      (review, it) => verifyMany(review?.findings || [], dimOf(it), sourceOf(it))
    )
  } catch (e) {
    log(`WARN: ${phaseName} pass failed — continuing without it: ${e?.message || e}`)
    return []
  }
  return res.flat().filter(Boolean)
}
const CLASSIFY_NOTE = `For EACH finding set verify_class: 'falsifiable' if a test/PoC/probe could confirm it at runtime (a concrete behavioral/runtime claim at a file:line), else 'judgment' (maintainability, methodology, architecture, or an absent-control claim).`

// ===========================================================================
// PHASE: Profile
// ===========================================================================
phase('Profile')
const profile = await withRetry(() => agent(
  `Profile the software repository at ${ROOT} for an audit. Use shell (ls, find, read the manifest and a few key files) to determine facts — do not guess.\n\nReport: language & build system; test command; KIND (library/CLI/server/MCP-server/web-app/data-pipeline/other); DOMAIN (plain words); 3-6 cohesive SUBSYSTEMS (one-liner + files each); EXTERNAL dependencies; largest source files; SOURCE_FILE_COUNT (approx number of first-party source files — count them with shell, e.g. git ls-files on source dirs; exclude vendored/generated/deps/tests-if-trivial); top-level SOURCE DIRS for analyzers (src_dirs); GIT_STATUS (run 'git fetch -q' if a remote exists, then report whether the checkout is current/behind-remote/dirty — behind-remote means the audit may be looking at STALE code).\n\nFrom this menu of domain-specialist review lenses, SELECT into selected_domain_lenses the keys that GENUINELY apply to this repo (semantic judgment, not keyword match) — choose only those whose expertise is actually relevant; [] if none:\n${LENS_MENU}`,
  { label: 'profile-repo', phase: 'Profile', model: cfg.workerModel, schema: PROFILE_SCHEMA }
))
if (!profile) throw new Error('Profile agent returned no result after retries — check repoRoot accessibility and model availability.')
const SUBSYSTEMS = (profile.subsystems || []).slice(0, 6)
const ext = (profile.external_deps || []).join(', ') || 'none detected'
const largest = (profile.largest_files || []).join(', ') || 'n/a'
const picked = cfg.domainLenses.length ? cfg.domainLenses
  : (Array.isArray(profile.selected_domain_lenses) && profile.selected_domain_lenses.length ? profile.selected_domain_lenses : autoDetectDomainLenses(profile))
const domainKeys = picked.filter(k => DOMAIN_LENS_LIB[k])
// Resolve 'auto' fanout now that we know the repo size: large repos => batched verification,
// which is ~5-8x fewer verifier agents (cost + rate-limit pressure) at a modest precision cost.
if (cfg.fanout === 'auto') {
  const fcount = Number(profile.source_file_count) || 0
  if (fcount > AUTO_BATCH_FILES) {
    verifyMode = 'batched'
    log(`auto-fanout: ~${fcount} source files (> ${AUTO_BATCH_FILES}) → batched verification to control cost & rate-limit pressure. Override with fanout:"standard" for per-finding verification.`)
  } else {
    log(`auto-fanout: ~${fcount || 'unknown'} source files (≤ ${AUTO_BATCH_FILES}) → per-finding verification.`)
  }
}
log(`Profiled: ${profile.language} ${profile.kind} — "${profile.domain}". ${SUBSYSTEMS.length} subsystems, ~${profile.source_file_count ?? '?'} source files. Domain lenses: ${domainKeys.join(', ') || 'none'}. fanout=${cfg.fanout} verify=${verifyMode} trust=${cfg.trustLevel} exec-verify=${doExecVerify} worker=${cfg.workerModel} verifier=${cfg.verifierModel}`)
if (!canExecute) log(`NOTE: trustLevel=untrusted — GroundTruth tool execution is DISABLED (inspection only). Run the auditor itself in a sandbox if you want execution.`)
// Pre-flight hygiene (#5): warn on stale checkout (we once audited month-old code) and on sleep risk.
const gs = profile.git_status
if (gs === 'behind-remote' || gs === 'behind-and-dirty') log(`⚠ STALE CHECKOUT: ${ROOT} is BEHIND its remote — you may be auditing outdated code. Pull/fetch before trusting findings (a fixed-upstream bug can show as a live finding).`)
else if (gs === 'dirty') log(`NOTE: working tree is dirty — findings reflect uncommitted local changes.`)
if ((Number(profile.source_file_count) || 0) > AUTO_BATCH_FILES) log(`NOTE: large repo — this run spawns many agents over a while. Keep the host AWAKE (on AC / lid open / \`caffeinate -dimsu\`); host sleep suspends the run and balloons wall-clock.`)

// ===========================================================================
// PHASE: Recon
// ===========================================================================
phase('Recon')
const repoMap = (await parallel(SUBSYSTEMS.map(s => () =>
  withRetry(() => agent(
    `Map the subsystem "${s.key}" of the repo at ${ROOT}: ${s.desc}\nFiles: ${(s.files || []).join(', ') || '(discover them)'}\n\nRead the actual files. Report purpose, key files, entry points, all external I/O (network, env, filesystem, devices, untrusted input), and risks/smells/strengths. Concrete file:line refs. Map and observe only — do not fix.`,
    { label: `map:${s.key}`, phase: 'Recon', model: cfg.workerModel, schema: MAP_SCHEMA }
  )).catch(e => { log(`WARN: recon map of "${s.key}" failed: ${e?.message || e}`); return null })
))).filter(Boolean)
const mapDigest = repoMap.map(m =>
  `## ${m.subsystem} — ${m.purpose}\nKey files: ${(m.key_files || []).join(', ')}\nExternal I/O: ${(m.external_io || []).join('; ') || 'none noted'}\nObservations: ${(m.observations || []).join(' | ')}`
).join('\n\n')

// ===========================================================================
// PHASE: Audit (universal framed dimensions)
// ===========================================================================
phase('Audit')
const DIMENSIONS = [
  { key: 'security', prompt: `Audit for SECURITY vulnerabilities: secrets/credential handling, outbound network calls and how untrusted remote data is parsed, injection (incl. prompt injection if LLMs), unsafe deserialization, path traversal, authz/exposure. External deps: ${ext}. Cite file:line + excerpt.` },
  { key: 'quality', prompt: `Audit CODE QUALITY/maintainability: duplication, excessive complexity (largest: ${largest}), poor error handling, weak types, leaky abstractions, dead code, inconsistent patterns. Earned complexity vs bloat. Cite file:line.` },
  { key: 'correctness', prompt: `Audit CORRECTNESS/bugs: logic errors, async correctness, edge cases (empty/None, off-by-one, div-by-zero, float/boundary), state mutation, silent exception swallowing, numeric/statistical math. Cite file:line.` },
  { key: 'deps', prompt: `Audit DEPENDENCIES/supply chain. Read the manifest (${profile.build_system || 'manifest'}). Pinning, known-vuln/unmaintained packages, over-broad surface, missing lockfile, license, nonexistent/internal-only deps. Cite specifics.` },
  { key: 'tests', prompt: `Audit TEST COVERAGE gaps. Test command: ${profile.test_command || 'unknown'}. Untested critical paths, error/edge paths, core logic with zero coverage. Cite what's missing and why.` },
].filter(d => !skip(d.key))

const framedFindings = await lensPass(
  DIMENSIONS, 'Audit',
  d => `${d.prompt}\n\n${CLASSIFY_NOTE}\n\nRepo map:\n${mapDigest}\n\nReturn every real finding with severity, file:line, evidence, recommendation, effort, verify_class. Quality over quantity.`,
  d => d.key, () => 'framed'
)

// ===========================================================================
// Breadth passes (skipped in fanout='quick')
// ===========================================================================
let sweepFindings = [], criticFindings = [], bizFindings = [], improveFindings = [], readinessFindings = [], seamFindings = []

if (runBreadth && budgetExceeded()) log(`BUDGET: token cap (${tokenCap}) reached after framed audit — skipping breadth passes (sweep/critic/bizlogic/improve/readiness/seam). Synthesis will run on what was collected.`)
if (runBreadth && !budgetExceeded()) {
  phase('Sweep')
  sweepFindings = await lensPass(
    SUBSYSTEMS, 'Sweep',
    s => `Open-ended review of subsystem "${s.key}" of the repo at ${ROOT}: ${s.desc}\n\nRead with fresh eyes — no checklist. What is wrong, surprising, fragile, or off? Bugs, silent no-ops, dead code, broken cross-module assumptions, footguns, features that don't do what their name claims. ${CLASSIFY_NOTE}\nReport each with severity, file:line, excerpt, recommendation, effort, verify_class. Only what you can prove.`,
    s => `sweep:${s.key}`, () => 'sweep'
  )

  phase('Critic')
  const priorForCritic = [...framedFindings, ...sweepFindings]
  const priorDigest = priorForCritic.map(f => `[${f.dimension}] ${f.title} (${f.file})`).join('\n')
  let critique = null
  try {
    critique = await withRetry(() => agent(
      `Completeness critic for an audit of the repo at ${ROOT}. A framed dimension audit and an unframed sweep already ran (below). Find ONLY what they MISSED. Probe negative space: uncited files/modules, unprobed failure modes (malformed input, concurrency/ordering, time/timezone, numerical stability, resource exhaustion), unchecked cross-module contracts, whole absent CLASSES (observability, config drift, data migration, races). Read the repo to confirm gaps. NEW findings only. ${CLASSIFY_NOTE}\n\nALREADY FOUND (${priorForCritic.length}):\n${priorDigest}\n\nREPO MAP:\n${mapDigest}`,
      { label: 'completeness-critic', phase: 'Critic', model: cfg.workerModel, schema: FINDINGS_SCHEMA }
    ))
  } catch (e) { log(`WARN: completeness critic failed: ${e?.message || e}`) }
  criticFindings = await verifyMany(critique?.findings || [], 'critic', 'critic')

  phase('BizLogic')
  bizFindings = await lensPass(
    SUBSYSTEMS, 'BizLogic',
    s => `Business-logic audit of subsystem "${s.key}" of the repo at ${ROOT}: ${s.desc}\n\nNOT a bug hunt. Enumerate FEATURES, CONTROLS, CLAIMS — docstring promises, config options, named safeguards, gates, filters, transforms — and verify each ACTUALLY does what it claims. Look for: controls with no effect (filters matching nothing, gates always true/false), features disabled/unreachable under default config, unreachable branches, params read but never applied, behavior diverging from name/docstring. ${CLASSIFY_NOTE} (most of these ARE falsifiable — a probe shows the control does nothing.)\nFor each divergence: claim vs actual, file:line, severity, recommendation, effort, verify_class.`,
    s => `biz:${s.key}`, () => 'biz-logic'
  )

  phase('Improve')
  const IMPROVE_AREAS = [
    { key: 'performance', prompt: `Find PERFORMANCE opportunities: redundant external/API calls, parallelizable/cacheable work, N+1 patterns, repeated parse/serialize, blocking I/O on hot paths.` },
    { key: 'observability', prompt: `Find OBSERVABILITY gaps: undebuggable failures — missing structured logging, no request/run IDs, silent fallbacks, no error metrics, exceptions logged without context.` },
    { key: 'architecture', prompt: `Find ARCHITECTURE/simplification opportunities: modules to decompose (largest: ${largest}), leaky boundaries, missing single-source-of-truth, coupling-reducing abstractions. Net-simplification only.` },
    { key: 'dx', prompt: `Find DEVELOPER-EXPERIENCE and product-capability opportunities: local run/test friction, missing config validation/clear errors, capabilities that materially increase value.` },
    { key: 'reduction', prompt: `Find REDUCTIVE improvements — where REMOVING/SIMPLIFYING wins. Hunt: dead/unreachable code, vestigial features kept alive only by tests, half-built functionality, redundant abstraction layers, unused config/params, defensive code for impossible states, collapsible duplication, over-engineered generality. Propose what to DELETE/merge/inline and why the system is better without it.` },
  ].filter(a => !skip(a.key))
  improveFindings = await lensPass(
    IMPROVE_AREAS, 'Improve',
    a => `${a.prompt}\n\nOPPORTUNITY scan, not a defect hunt — grounded in actual code. Each: what to improve, why it pays off, file:line, recommendation, effort, verify_class.\n\nBIAS CHECK — resist the additive default: first ask whether REMOVING/refactoring/collapsing achieves the goal better than adding. Prefer the reductive option when competitive. Net lines removed is a feature.\n\n${CLASSIFY_NOTE}\nRepo map:\n${mapDigest}`,
    a => `improve:${a.key}`, () => 'improvement'
  )

  phase('Readiness')
  const READINESS_LENSES = [
    { key: 'resilience', expert: 'a reliability engineer', prompt: `Audit RESILIENCE/fault tolerance vs external deps (${ext}). Per external call site: behavior on timeout, 429, 5xx, connection error, partial/empty response. Retries/backoff/circuit breakers? Does one transient failure kill a run? Graceful degradation? Cite file:line + the missing control.` },
    { key: 'auditability', expert: 'an ML-reproducibility / auditability reviewer', prompt: `Audit AUDITABILITY/REPRODUCIBILITY: can important outputs be reconstructed/explained after the fact? Enough provenance (versions, inputs, params, intermediate state, logs)? Deterministic where it should be? Flag gaps that make a past output unauditable. Cite file:line.` },
    { key: 'ops-cost', expert: 'an SRE / platform engineer', prompt: `Audit OPERATIONAL READINESS + RESOURCE/COST GOVERNANCE: CI/CD, lockfile, linter/type/coverage config, README/docs, fail-fast config validation. If it calls paid/external APIs: runaway-cost/rate-limit risk and budget caps. For absent controls, cite the file that SHOULD contain it.` },
  ].filter(L => !skip(L.key))
  const domainLensList = domainKeys.map(k => ({ key: k, expert: DOMAIN_LENS_LIB[k].expert, prompt: DOMAIN_LENS_LIB[k].prompt })).filter(L => !skip(L.key))
  readinessFindings = await lensPass(
    [...READINESS_LENSES, ...domainLensList], 'Readiness',
    L => `Act as ${L.expert} reviewing the repo at ${ROOT} for production readiness.\n\n${L.prompt}\n\n${CLASSIFY_NOTE}\nRepo map:\n${mapDigest}\n\nConcrete findings with severity, file:line, evidence, recommendation, effort, verify_class. Only what you can ground in the code.`,
    L => `readiness:${L.key}`, () => 'readiness'
  )

  // ---- Seam pass: cross-subsystem interface code (the class that lives between modules) ----
  phase('Seam')
  let seam = null
  try {
    seam = await withRetry(() => agent(
      `Audit the SEAMS between subsystems of the repo at ${ROOT} — the interface code where modules MEET, not the modules themselves. Subsystems: ${SUBSYSTEMS.map(s => s.key).join(', ')}.\n\nRead the actual producer/consumer interface code (function signatures, shared keys/field names, serialized contracts, schema assumptions, trust boundaries, error/exception contracts). Look for: producer/consumer key or field-name MISMATCHES (a value written under one name and read under another), schema assumptions that don't hold across the boundary, data crossing a trust boundary unvalidated, ordering/lifecycle assumptions between modules, and error contracts that don't match. Cite file:line on BOTH sides of each seam. ${CLASSIFY_NOTE}\n\nRepo map:\n${mapDigest}`,
      { label: 'seam', phase: 'Seam', model: cfg.workerModel, schema: FINDINGS_SCHEMA }
    ))
  } catch (e) { log(`WARN: seam pass failed: ${e?.message || e}`) }
  seamFindings = await verifyMany(seam?.findings || [], 'seam', 'seam')
}

// ===========================================================================
// PHASE: GroundTruth (gated by trustLevel)
// ===========================================================================
phase('GroundTruth')
let toolFindings = []
if (canExecute && budgetExceeded()) {
  log(`GroundTruth SKIPPED: token cap (${tokenCap}) reached. Re-run analyzers manually or raise maxOutputTokens.`)
} else if (!canExecute) {
  log('GroundTruth SKIPPED: trustLevel=untrusted (no code execution). Add a CI/analyzer-not-run gap manually if needed.')
} else {
  const langKey = (profile.language || '').toLowerCase()
  const tchain = TOOLCHAINS[langKey]
  const srcTarget = (profile.src_dirs && profile.src_dirs.length) ? profile.src_dirs.join(' ') : '.'
  const testCmd = profile.test_command || 'the test suite'
  const toolGuidance = tchain
    ? `Suggested ${langKey} tools (adapt to what's installed; a tool NOT wired into the project is itself a finding; install transient analyzers only if trivial):\n  - ` +
      tchain.map(c => c.replace(/<SRC>/g, srcTarget).replace('<TEST>', testCmd)).join('\n  - ')
    : `No built-in toolchain for "${profile.language}". DISCOVER the idiomatic static-analysis/security/dep-audit/test tools for this language, run the available ones from the repo root, and report "no analyzer wired into the project" where warranted. Test command: ${testCmd}.`
  try {
    const toolResult = await withRetry(() => agent(
      `Run real static-analysis / security / test tools against the repo at ${ROOT} for GROUND-TRUTH evidence. Project: ${profile.language}.\n\n${toolGuidance}\n\nRun each from the repo root, capture output. Per tool: did it run, issue count by severity, most important specific issues with file:line. Convert NOTABLE results into findings (severity, file:line, evidence=the tool's actual output line, recommendation, effort). Be factual — quote real output, never invent. Report whether tests pass.`,
      { label: 'ground-truth-tools', phase: 'GroundTruth', model: cfg.workerModel, schema: FINDINGS_SCHEMA }
    ))
    toolFindings = (toolResult?.findings || []).map(f => ({ ...f, dimension: f.dimension || 'tooling', source: 'tool', verdict: { real: true, unverified: false, provenance: 'tool-reported', reasoning: 'reported by an executed analysis tool (ground truth)', votes: 0, real_votes: 0 } }))
  } catch (e) {
    log(`WARN: GroundTruth tool pass failed — tool findings unavailable: ${e?.message || e}`)
  }
}

// ===========================================================================
// Merge — three verdict states (confirmed/refuted/unverified), provenance-stamped
// ===========================================================================
const allFindings = [...framedFindings, ...sweepFindings, ...criticFindings, ...bizFindings, ...improveFindings, ...readinessFindings, ...seamFindings, ...toolFindings]
const confirmed = allFindings.filter(f => f.verdict?.real)
const unverifiedF = allFindings.filter(f => f.verdict?.unverified)
const refuted = allFindings.filter(f => !f.verdict?.real && !f.verdict?.unverified)
const bySource = { framed: framedFindings.length, sweep: sweepFindings.length, critic: criticFindings.length, 'biz-logic': bizFindings.length, improvement: improveFindings.length, readiness: readinessFindings.length, seam: seamFindings.length, tool: toolFindings.length }
const execConfirmed = confirmed.filter(f => f.verdict?.provenance === 'execution-confirmed').length
log(`All passes complete: ${allFindings.length} findings (${confirmed.length} confirmed [${execConfirmed} execution-grounded], ${refuted.length} refuted, ${unverifiedF.length} UNVERIFIED) — ${JSON.stringify(bySource)}`)

// ===========================================================================
// PHASE: Plan — severity recalibration + dedup + triage + provenance-weighted scorecard
// ===========================================================================
phase('Plan')
const idFor = (f, i) => `${(f.dimension || 'GEN').replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase() || 'GEN'}-${i + 1}`
const provLabel = f => f.verdict?.provenance || (f.verdict?.unverified ? 'unverified' : (f.verdict?.real ? 'single-model-inspection' : 'single-model-inspection'))
const vlabel = f => f.verdict?.unverified ? 'UNVERIFIED' : (f.verdict?.real ? 'CONFIRMED' : 'REFUTED')
const lineFor = (f, i) =>
  `### ${idFor(f, i)} [${f.dimension}] source=${f.source} verifier=${vlabel(f)} provenance=${provLabel(f)}${f.verdict?.votes > 1 ? `(${f.verdict.real_votes}/${f.verdict.votes})` : ''} severity=${f.severity} effort=${f.effort}\n` +
  `title: ${f.title}\nfile: ${f.file}\nevidence: ${(f.evidence || '').slice(0, 400)}\nrecommendation: ${(f.recommendation || '').slice(0, 300)}\nverifier: ${(f.verdict?.reasoning || 'n/a').slice(0, 200)}` +
  (f.verdict?.severity_adjustment ? `\nseverity_note: ${f.verdict.severity_adjustment}` : '')

const RECALIBRATE = `SEVERITY RECALIBRATION (do this FIRST, before ranking): each finder used its own bar AND finders systematically OVER-rate — so re-score every finding against ONE rubric, biased toward DOWN-grading. Rubric — critical: exploitable/data-corrupting in NORMAL use, no attacker needed; high: wrong-result under realistic input OR exploitable under attacker control, reachable on a real code path; medium: latent risk, or material maintainability/observability cost; low: style/polish/defensive-nit. DEFAULT DOWN, JUSTIFY UP: assign the LOWER severity unless you can name the concrete trigger and blast radius that earns the higher one. Specifically demote: maintainability/duplication/observability/logging findings are at most MEDIUM (never high) unless they cause a wrong result; "missing CI/lockfile/type-check" supply-chain gaps are MEDIUM unless they ship a known-exploitable artifact; latent bugs unreachable under default config are at most MEDIUM. A finding is only critical/high if a reader could write the failing input or exploit from your evidence. Use the recalibrated severity in triage and ranking.`
const PROVENANCE_RULE = `PROVENANCE WEIGHTING: trust order is execution-confirmed > tool-reported > stronger-tier-agreed > single-model-inspection > unverified. An execution-confirmed or tool-reported critical may be a hard RED. A critical that is only single-model-inspection or judgment-class gets verdict NEEDS-HUMAN (not auto-RED). UNVERIFIED findings are unconfirmed (needs human check), NOT refuted — say so in their triage rationale.`
const ranSources = Object.entries(bySource).filter(([, n]) => n > 0).map(([k, n]) => `${k}(${n})`).join(', ')

const SCORECARD_CATS = `Functional correctness, Business logic, Security, Resilience, Auditability/reproducibility, Code quality, Testing, Dependencies/supply-chain, Observability, Operational readiness, Cost governance, Performance${domainKeys.length ? ', ' + domainKeys.join(', ') : ''}`

function metaPrompt(findingsText, triagePreamble) {
  return `You are the synthesis lead producing a PRODUCTION-READINESS assessment of the repo at ${ROOT} (${profile.language} ${profile.kind} — "${profile.domain}"). ${allFindings.length} findings total. PASSES THAT RAN (source:count): ${ranSources}. Do NOT grade a category from the absence of a pass that did not run — mark it N/A or note the gap.\n\n${RECALIBRATE}\n\n${PROVENANCE_RULE}\n\nDEDUP: passes overlap; MERGE findings describing the same issue at the same location into one triage entry, cite all merged IDs, treat independent rediscovery as a CONFIDENCE signal.\n\nProduce:\n1. scorecard — one row per relevant category (${SCORECARD_CATS}). GREEN/YELLOW/RED/NEEDS-HUMAN/N/A + one-line summary + concrete bar_to_clear + blocking triage IDs.\n2. triage — one entry per distinct issue (merged), with verifier_verdict, provenance, recalibrated severity, disposition, rationale.\n3. prioritized_actions — DEFECTS only, ranked by (severity × leverage)/effort. Reductive fixes that remove code while solving the problem rank as well as additive ones.\n4. opportunities — source=improvement items on their OWN scale, ranked separately from defects.\n5. quick_wins — trivial/small effort, high value.\n6. themes — cross-cutting patterns, incl. classes the seam/critic/biz-logic passes surfaced that framed audits missed.\n\nBe concrete, reference files, invent nothing.\n${triagePreamble}\nFINDINGS:\n${findingsText}\n\nREPO MAP:\n${mapDigest}`
}

// Map a finding to a scorecard category (for hierarchical grouping).
function categoryOf(f) {
  const d = f.dimension || ''
  if (f.source === 'tool') return 'Tooling'
  if (f.source === 'improvement') return 'Opportunities'
  if (f.source === 'biz-logic') return 'Business logic'
  if (f.source === 'seam') return 'Functional correctness'
  if (f.source === 'critic') return 'Cross-cutting'
  if (d === 'security') return 'Security'
  if (d === 'quality') return 'Code quality'
  if (d === 'correctness') return 'Functional correctness'
  if (d === 'deps') return 'Dependencies/supply-chain'
  if (d === 'tests') return 'Testing'
  if (d === 'readiness:resilience') return 'Resilience'
  if (d === 'readiness:auditability') return 'Auditability/reproducibility'
  if (d === 'readiness:ops-cost') return 'Operational readiness'
  if (d.startsWith('readiness:')) return d.replace('readiness:', '')   // domain lens => its own category
  if (d.startsWith('sweep:')) return 'Functional correctness'
  return 'General'
}

const fullFindingsText = allFindings.map((f, i) => lineFor(f, i)).join('\n\n')
if (fullFindingsText.length > 120000) log(`NOTE: findings block is ${fullFindingsText.length} chars. ${cfg.hierarchicalSynthesis ? 'Using hierarchical synthesis.' : 'Consider hierarchicalSynthesis:true or economy/skipLenses.'}`)

// Synthesis. Default = single-pass (proven). Hierarchical = opt-in (experimental): per-category
// sub-synthesis in tight contexts, then a meta pass — falls back to single on any failure.
async function singleSynthesis() {
  return await withRetry(() => agent(metaPrompt(fullFindingsText || '(none found)', ''), { label: 'triage-and-scorecard', phase: 'Plan', schema: PLAN_SCHEMA }))
}
async function hierarchicalSynthesis() {
  const byCat = {}
  allFindings.forEach((f, i) => { const c = categoryOf(f); (byCat[c] = byCat[c] || []).push({ f, i }) })
  const cats = Object.keys(byCat)
  const subs = (await parallel(cats.map(c => () =>
    agent(
      `Sub-synthesis for category "${c}" of a production-readiness audit of ${ROOT}. ${RECALIBRATE}\n${PROVENANCE_RULE}\nDedup duplicates within this category. Produce a category verdict (GREEN/YELLOW/RED/NEEDS-HUMAN/N/A), one-line summary, the bar_to_clear, and a triage row per distinct issue.\n\nFINDINGS:\n${byCat[c].map(({ f, i }) => lineFor(f, i)).join('\n\n')}`,
      { label: `subsynth:${c}`, phase: 'Plan', model: cfg.workerModel, schema: SUBSYNTH_SCHEMA }
    ).then(r => ({ cat: c, ...r })).catch(() => null)
  ))).filter(Boolean)
  if (!subs.length) throw new Error('all sub-syntheses failed')
  const subDigest = subs.map(s => `## ${s.category} — ${s.verdict}\n${s.summary}\nbar: ${s.bar_to_clear}\ntriage:\n${(s.triage || []).map(t => `- [${t.id}] ${t.severity}/${t.disposition} (${t.verifier_verdict}/${t.provenance || '?'}) ${t.title} — ${t.rationale}`).join('\n')}`).join('\n\n')
  // Meta pass reasons over the compact sub-summaries (not all raw findings) — context stays tight.
  return await withRetry(() => agent(metaPrompt(subDigest, 'The findings below are PRE-SYNTHESIZED per category (verdict + triage already drafted). Assemble the final scorecard from these category verdicts, carry their triage rows into the global triage (dedup across categories), and add cross-category themes/prioritized_actions/opportunities/quick_wins.\n'), { label: 'meta-synthesis', phase: 'Plan', schema: PLAN_SCHEMA }))
}

let plan
try {
  plan = (cfg.hierarchicalSynthesis && allFindings.length > 120)
    ? await hierarchicalSynthesis().catch(async (e) => { log(`WARN: hierarchical synthesis failed (${e?.message || e}) — falling back to single synthesis.`); return await singleSynthesis() })
    : await singleSynthesis()
} catch (e) {
  log(`ERROR: synthesis failed after retries (${e?.message || e}). Returning raw findings WITHOUT scorecard so the audit data survives — re-run synthesis from all_findings.`)
  plan = { error: 'synthesis-failed', message: String(e?.message || e) }
}

// ID consistency check (non-fatal): every triage ID (incl. merged 'A+B') should reference a real finding ID.
if (plan && Array.isArray(plan.triage)) {
  const valid = new Set(allFindings.map((f, i) => idFor(f, i)))
  let bad = 0
  for (const t of plan.triage) for (const part of String(t.id || '').split('+')) if (part.trim() && !valid.has(part.trim())) bad++
  if (bad) log(`NOTE: ${bad} triage ID reference(s) don't match a known finding ID — cross-referencing plan↔all_findings by ID may be imperfect.`)
}

return {
  repo: ROOT,
  profile: { language: profile.language, kind: profile.kind, domain: profile.domain, subsystems: SUBSYSTEMS.map(s => s.key), domain_lenses: domainKeys, fanout: cfg.fanout, trustLevel: cfg.trustLevel, exec_verify: doExecVerify },
  total_findings: allFindings.length,
  confirmed_count: confirmed.length,
  refuted_count: refuted.length,
  unverified_count: unverifiedF.length,
  execution_confirmed_count: execConfirmed,
  by_source: bySource,
  plan,
  all_findings: allFindings.map((f, i) => ({
    id: idFor(f, i), dimension: f.dimension, source: f.source, title: f.title,
    severity: f.severity, file: f.file, effort: f.effort,
    verify_class: f.verify_class || 'judgment',
    verifier_verdict: f.verdict?.unverified ? 'unverified' : (f.verdict?.real ? 'confirmed' : 'refuted'),
    provenance: f.verdict?.provenance || null,
    verifier_reasoning: f.verdict?.reasoning, evidence: f.evidence, recommendation: f.recommendation,
    reproduction: f.verdict?.reproduction || null,
  })),
}
