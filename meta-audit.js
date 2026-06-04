export const meta = {
  name: 'meta-audit',
  description: 'Audit-of-the-audit: independently re-derive each finding from the real code, adversarially verify by execution where falsifiable (write+run a repro to confirm/refute) and stronger-tier reasoning where judgment, plus a per-subsystem recall pass for findings the original audit missed; report agreement, false positives, false negatives, and severity miscalibration',
  whenToUse: 'Point at a repo-audit result to grade the audit itself. args:{repo, inputJsonl, indexPath, subsystems?, workerModel?, verifierModel?}. Falsifiable findings are checked by EXECUTION (runs the repo code — trusted repos only); judgment findings by adversarial reasoning.',
  phases: [
    { title: 'Bootstrap', detail: 'load the finding index' },
    { title: 'Recheck', detail: 'independent finder re-derives each claim from the real code' },
    { title: 'Adjudicate', detail: 'adversarial verify: execution repro for falsifiable, Opus reasoning for judgment' },
    { title: 'Missed', detail: 'per-subsystem recall pass for issues the original audit missed' },
    { title: 'Synthesis', detail: 'agreement matrix, false positives/negatives, severity corrections, audit trust grade' },
  ],
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A || {}
if (!A.repo || !A.inputJsonl || !A.indexPath) {
  throw new Error('meta-audit requires args:{repo, inputJsonl, indexPath}. Got: ' + JSON.stringify(Object.keys(A)))
}
const REPO = A.repo
const JSONL = A.inputJsonl
const workerModel = A.workerModel || 'sonnet'
const verifierModel = A.verifierModel || 'opus'

async function withRetry(fn, attempts = 2) {
  let last
  for (let i = 0; i < attempts; i++) { try { return await fn() } catch (e) { last = e } }
  throw last
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
// Stage 1 — independent re-derivation of the original finding from the code.
const RECHECK_SCHEMA = {
  type: 'object',
  required: ['claim_holds', 'original_verdict_correct', 'meta_verdict', 'severity_assessment', 'reasoning'],
  properties: {
    claim_holds: { type: 'boolean', description: 'Does the evidence actually hold at the cited file:line in the real code?' },
    original_verdict_correct: { type: 'boolean', description: 'Was the audit\'s confirmed/refuted/unverified the right call?' },
    meta_verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'], description: 'your independent verdict on whether the finding is a real, material issue' },
    severity_assessment: { type: 'string', enum: ['correct', 'too-high', 'too-low'] },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'n/a'] },
    reasoning: { type: 'string', description: 'code-grounded; cite what you read' },
  },
}

// Stage 2 — adversarial adjudication. Execution path (falsifiable) or reasoning path (judgment).
const ADJUDICATE_SCHEMA = {
  type: 'object',
  required: ['method', 'final_meta_verdict', 'overturns_recheck', 'reasoning'],
  properties: {
    method: { type: 'string', enum: ['execution', 'reasoning'], description: 'how this adjudication was reached' },
    final_meta_verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
    overturns_recheck: { type: 'boolean', description: 'did the adversarial pass overturn the stage-1 re-check?' },
    provenance: { type: 'string', enum: ['execution-confirmed', 'execution-refuted', 'execution-inconclusive', 'stronger-tier-reasoning', 'reasoning'] },
    severity_final: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'n/a'] },
    // Two-gate judgment. Manifesting a behavior is necessary but NOT sufficient
    // to confirm a defect — a behavior can manifest yet be correct-by-design.
    manifests: { type: 'boolean', description: 'does the claimed behavior actually occur (runtime repro, or code reading if reasoning)?' },
    is_genuine_defect: { type: 'boolean', description: 'GIVEN it manifests, is it actually WRONG — not correct/intended (e.g. correct cancellation, documented tradeoff, defensive default)?' },
    fix_is_sound: { type: 'boolean', description: 'would the recommended fix avoid regressing a different correctness property (e.g. not swallow KeyboardInterrupt)?' },
    reproduction: {
      type: 'object',
      properties: {
        repro_code: { type: 'string' },
        executed: { type: 'boolean' },
        hit_cited_line: { type: 'boolean' },
        observed: { type: 'string', enum: ['confirmed', 'not-reproduced', 'inconclusive', 'n/a'] },
        output: { type: 'string', description: 'REAL run output — never invented' },
      },
    },
    reasoning: { type: 'string' },
  },
}

const MISSED_SCHEMA = {
  type: 'object', required: ['missed_findings'],
  properties: {
    missed_findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'file', 'evidence', 'why_missed'],
        properties: {
          title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' }, evidence: { type: 'string' },
          verify_class: { type: 'string', enum: ['falsifiable', 'judgment'] },
          why_missed: { type: 'string', description: 'why a framed audit plausibly skipped it' },
        },
      },
    },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['audit_trust_grade', 'executive_summary', 'agreement', 'false_positives', 'false_negatives', 'severity_corrections', 'themes'],
  properties: {
    audit_trust_grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'], description: 'overall trustworthiness of the original audit' },
    executive_summary: { type: 'string' },
    agreement: {
      type: 'object', required: ['total', 'agreed', 'overturned', 'execution_grounded'],
      properties: {
        total: { type: 'number' }, agreed: { type: 'number' }, overturned: { type: 'number' },
        execution_grounded: { type: 'number', description: 'count adjudicated by actually running code' },
      },
    },
    false_positives: { type: 'array', description: 'audit said confirmed; meta-audit refutes', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'string' }, severity: { type: 'string' }, why: { type: 'string' } } } },
    false_negatives: { type: 'array', description: 'audit refuted/missed; meta-audit confirms real', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'string' }, severity: { type: 'string' }, why: { type: 'string' } } } },
    severity_corrections: { type: 'array', items: { type: 'object', required: ['id', 'from', 'to'], properties: { id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' } } } },
    themes: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
// Bootstrap — load the index (script can't read files; an agent returns it,
// schema-validated so truncation auto-retries rather than corrupting the run)
// ---------------------------------------------------------------------------
const INDEX_SCHEMA = {
  type: 'object', required: ['findings', 'subsystems'],
  properties: {
    subsystems: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'severity', 'verdict', 'verify_class'],
        properties: {
          id: { type: 'string' }, severity: { type: 'string' }, verdict: { type: 'string' },
          verify_class: { type: 'string' }, blocking: { type: 'boolean' },
        },
      },
    },
  },
}
phase('Bootstrap')
const idx = await withRetry(() => agent(
  `Read the JSON file ${A.indexPath}. It has keys: repo, subsystems (array of strings), and index (an array of finding objects, each with id/severity/verdict/verify_class/blocking). Return ALL of the index array as "findings" and the subsystems array as "subsystems". Include every finding — do not sample or truncate.`,
  { label: 'bootstrap-index', phase: 'Bootstrap', model: workerModel, schema: INDEX_SCHEMA }
))
const FINDINGS = idx.findings || []
const SUBSYSTEMS = A.subsystems || idx.subsystems || []
if (!FINDINGS.length) throw new Error('bootstrap: index had no findings')
const nFals = FINDINGS.filter(f => f.verify_class === 'falsifiable').length
log(`Loaded ${FINDINGS.length} findings (${nFals} falsifiable → execution path, ${FINDINGS.length - nFals} judgment → reasoning path). Subsystems: ${SUBSYSTEMS.join(', ')}`)

const isHighStakes = f => f.severity === 'critical' || f.severity === 'high' || f.verdict === 'unverified' || f.blocking === true

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function recheckPrompt(f) {
  return `You are independently re-auditing a SINGLE finding from a prior production-readiness audit of the repo at ${REPO}. Do NOT trust the original verdict — re-derive it yourself from the actual code.

Finding id: ${f.id}
First, get the original finding's full record: run \`grep -F '"id": "${f.id}"' ${JSONL}\` and read the title, severity, file, evidence, recommendation, the audit's verdict, and the audit's verifier_reasoning.

Then READ the actual code at the cited file (under ${REPO}) and judge, on your own:
1. claim_holds — does the cited evidence actually exist at that location in the real code?
2. original_verdict_correct — was the audit's confirmed/refuted/unverified the right call?
3. meta_verdict — YOUR independent verdict: is this a real, material issue (confirmed), not real / already handled (refuted), or genuinely undecidable from code alone (unverified)?
4. severity_assessment + corrected_severity against ONE rubric — critical: exploitable/data-corrupting in normal use; high: wrong-result under realistic input or exploitable under attacker control; medium: latent risk or material maintainability cost; low: style/polish.

Be specific and code-grounded. If the original audit over-claimed (plausible-but-wrong), say so. If it under-rated a real issue, say so.`
}

function execAdjudicatePrompt(f, recheck) {
  return `ADVERSARIAL execution-grounded adjudication of a finding for the repo at ${REPO}. This finding is FALSIFIABLE — settle it by RUNNING code, not by opinion. You are working in the user's own trusted repo; running its code and writing a throwaway repro is permitted. Do not modify tracked source files.

Finding id: ${f.id} (cited file: ${f.file}, original severity: ${f.severity})
Get the full record: \`grep -F '"id": "${f.id}"' ${JSONL}\`.
A prior independent re-check concluded: meta_verdict=${recheck?.meta_verdict}, claim_holds=${recheck?.claim_holds}, reasoning="${(recheck?.reasoning || '').slice(0, 300)}".

YOUR JOB is adversarial, in TWO gates. A finding is CONFIRMED only if it passes BOTH.

GATE 1 — does it MANIFEST? (execution settles this)
- Write the MINIMAL repro (failing test, exploit PoC, probe, or coverage check) that would manifest the claimed issue, from the repo root.
- RUN it. Capture the REAL output — never invent output.
- Confirm via instrumentation/coverage that your repro actually exercised the cited code (hit_cited_line). If it didn't reach the cited code, observed=inconclusive — do NOT report not-reproduced for a repro that never ran the code.
- Set manifests=true only if the behavior actually occurred at runtime.

GATE 2 — is the manifested behavior a genuine DEFECT? (judgment — execution CANNOT settle this)
- Manifesting is necessary but NOT sufficient. A behavior can manifest and still be correct-by-design: correct cooperative cancellation, a documented tradeoff, a defensive/fail-closed default. Adversarially argue whether the behavior is actually WRONG versus merely EXISTS.
- Pressure-test the recommended fix: would applying it regress a different correctness property (e.g. catching BaseException would swallow KeyboardInterrupt/SystemExit; a "fix" that breaks a documented guarantee)? Set fix_is_sound accordingly.
- Set is_genuine_defect=true only if the manifested behavior is genuinely wrong AND the fix is sound.

VERDICT: final_meta_verdict='confirmed' ONLY if manifests=true AND is_genuine_defect=true. If it manifests but is correct-by-design (is_genuine_defect=false), set final_meta_verdict='refuted', provenance='execution-refuted', reasoning="mechanism real but not a defect — <why intended/correct>". Set method='execution'. provenance otherwise: execution-confirmed (manifests AND genuine defect) | execution-refuted (did not manifest with the line hit, OR manifests-but-correct-by-design) | execution-inconclusive (couldn't run / didn't reach the line). If you truly cannot execute (tooling/permission blocked), set method='reasoning', provenance='reasoning', adjudicate BOTH gates by reading the code, and say why execution was impossible. Set overturns_recheck=true if you reached a different verdict than the re-check. Never silent-refute behind a FAILED repro: execution-inconclusive → unverified, not refuted (distinct from a deliberate correct-by-design refutation).`
}

function reasonAdjudicatePrompt(f, recheck) {
  return `ADVERSARIAL adjudication of a JUDGMENT-class finding for the repo at ${REPO} (no execution oracle exists — it is a matter of maintainability/architecture/methodology/severity, not a runtime fact). You are a stronger-tier reviewer.

Finding id: ${f.id} (cited file: ${f.file}, original severity: ${f.severity})
Get the full record: \`grep -F '"id": "${f.id}"' ${JSONL}\`. Read the cited code.
A prior re-check concluded: meta_verdict=${recheck?.meta_verdict}, reasoning="${(recheck?.reasoning || '').slice(0, 300)}".

Adversarially pressure-test it: is the finding real and material, or is it churn / a matter of taste / already mitigated elsewhere? Default to refuted if you cannot make a concrete, code-grounded case that it matters. Recalibrate severity against the rubric (critical/high/medium/low). Set method='reasoning', provenance='stronger-tier-reasoning', final_meta_verdict, overturns_recheck (true if you disagree with the re-check), severity_final, and code-grounded reasoning.`
}

// ---------------------------------------------------------------------------
// Recheck → Adjudicate pipeline (no barrier; each finding flows independently)
// ---------------------------------------------------------------------------
phase('Recheck')
const adjudicated = await pipeline(
  FINDINGS,
  // stage 1: independent re-derivation
  f => withRetry(() => agent(recheckPrompt(f), { label: `recheck:${f.id}`, phase: 'Recheck', model: workerModel, schema: RECHECK_SCHEMA }))
        .catch(() => null),
  // stage 2: adversarial adjudication, routed by oracle
  (recheck, f) => {
    const falsifiable = f.verify_class === 'falsifiable'
    const prompt = falsifiable ? execAdjudicatePrompt(f, recheck) : reasonAdjudicatePrompt(f, recheck)
    const model = falsifiable ? workerModel : (isHighStakes(f) ? verifierModel : workerModel)
    return agent(prompt, { label: `${falsifiable ? 'exec' : 'reason'}:${f.id}`, phase: 'Adjudicate', model, schema: ADJUDICATE_SCHEMA })
      .then(adj => ({ ...f, recheck, adj }))
      .catch(() => ({ ...f, recheck, adj: { method: 'reasoning', final_meta_verdict: 'unverified', overturns_recheck: false, provenance: 'reasoning', reasoning: 'UNVERIFIED — adjudicator threw; treat as unconfirmed, not refuted' } }))
  }
)
const rows = adjudicated.filter(Boolean)
const execGrounded = rows.filter(r => String(r.adj?.provenance || '').startsWith('execution-')).length
log(`Adjudicated ${rows.length}/${FINDINGS.length} findings (${execGrounded} settled by actual execution).`)

// ---------------------------------------------------------------------------
// Missed-findings recall pass (per subsystem)
// ---------------------------------------------------------------------------
phase('Missed')
// v1 flaw fix: the recall pass MUST dedup against what the audit already found, or it
// re-reports known findings as "missed" (it once flagged the audit's #1 critical as missed).
// The index carries no titles, but the JSONL does — so we hand each recall agent the list of
// already-covered files and require it to read existing findings from the JSONL before reporting.
const coveredFiles = Object.entries(
  FINDINGS.reduce((m, f) => { const k = (f.file || '').split('/').pop(); if (k) m[k] = (m[k] || 0) + 1; return m }, {})
).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(', ')
const missed = SUBSYSTEMS.length ? (await parallel(SUBSYSTEMS.map(s => () =>
  agent(
    `Recall check for the original audit of the repo at ${REPO}. Focus on subsystem "${s}". The original audit produced ${FINDINGS.length} findings; your job is to find REAL issues it MISSED ENTIRELY in this subsystem — NOT to re-list or rediscover what it already found.\n\nDEDUP IS MANDATORY. The original findings live in ${JSONL} (one JSON object per line, each with title/file/evidence). Files the audit ALREADY has findings in (with counts): ${coveredFiles || '(none)'}.\nBEFORE reporting any candidate: grep ${JSONL} for the file it lives in (e.g. \`grep -F '"file": ".../<filename>' ${JSONL}\` or grep the filename) and read the existing findings there. If an existing finding already covers the same MECHANISM (even under a different title, severity, or framing), it is NOT a miss — exclude it. Only report issues with no existing counterpart.\n\nRead the subsystem's source files under ${REPO}. Probe negative space: unhandled failure modes, absent controls, cross-module contract gaps, untested error paths, classes of issue a framed audit skips. MATERIALITY BAR (precision over recall): report a miss ONLY if it is confirmed absent from existing findings AND genuinely MATERIAL — would cause a wrong result, a security/safety issue, or a real production failure. EXCLUDE style, nits, theoretical edge cases, and minor observability/logging gaps. If nothing material is missing, return an empty list — a few real misses beat a long list. Each reported miss must be concrete and code-grounded at a file:line. Note why a framed audit plausibly skipped it.`,
    { label: `missed:${s}`, phase: 'Missed', model: workerModel, schema: MISSED_SCHEMA }
  ).then(r => ({ subsystem: s, ...(r || {}) })).catch(() => null)
))).filter(Boolean) : []
let missedCount = missed.reduce((n, m) => n + (m.missed_findings?.length || 0), 0)
log(`Recall pass: ${missedCount} candidate missed findings across ${missed.length} subsystems.`)

// Verify the candidates adversarially — otherwise they reach synthesis UNVERIFIED
// (the least-trustworthy output). Keep only real + novel + material misses.
const MISSED_VERDICT_SCHEMA = {
  type: 'object', required: ['is_real', 'is_novel', 'is_material'],
  properties: {
    is_real: { type: 'boolean', description: 'is the issue actually present at the cited file:line?' },
    is_novel: { type: 'boolean', description: 'genuinely NOT covered by any existing finding (grep the JSONL to check)?' },
    is_material: { type: 'boolean', description: 'wrong-result / security / real production failure (NOT style/nit/theoretical)?' },
    reasoning: { type: 'string' },
  },
}
if (missedCount) {
  const flat = []
  missed.forEach(m => (m.missed_findings || []).forEach(x => flat.push(x)))
  const verds = await parallel(flat.map(x => () =>
    agent(
      `Adversarially verify a candidate "MISSED" finding for the repo at ${REPO}. REFUTE it if you can. Read the cited code, and grep ${JSONL} to confirm no existing finding already covers this mechanism.\n\nTitle: ${x.title}\nFile: ${x.file}\nEvidence: ${(x.evidence || '').slice(0, 400)}\n\nSet is_real (present at the cited location), is_novel (NOT already covered by an existing finding), is_material (causes a wrong result / security / real failure — not style). Default false on anything you cannot concretely confirm.`,
      { label: `missed-verify:${(x.file || '').split('/').pop()}`, phase: 'Missed', model: workerModel, schema: MISSED_VERDICT_SCHEMA }
    ).then(v => ({ x, v })).catch(() => ({ x, v: null }))
  ))
  const keep = new Set(verds.filter(r => r.v && r.v.is_real && r.v.is_novel && r.v.is_material).map(r => r.x))
  missed.forEach(m => { m.missed_findings = (m.missed_findings || []).filter(x => keep.has(x)) })
  const kept = missed.reduce((n, m) => n + m.missed_findings.length, 0)
  log(`Recall verification: ${kept}/${missedCount} candidate misses survived (real + novel + material); ${missedCount - kept} dropped as noise.`)
  missedCount = kept
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------
phase('Synthesis')
const rowLine = r => `${r.id} [${r.severity}] audit=${r.verdict} | recheck=${r.recheck?.meta_verdict ?? '?'}(verdict_ok=${r.recheck?.original_verdict_correct ?? '?'}, sev=${r.recheck?.severity_assessment ?? '?'}) | adj=${r.adj?.final_meta_verdict}(${r.adj?.provenance || r.adj?.method}, overturns=${r.adj?.overturns_recheck}) | ${(r.adj?.reasoning || '').slice(0, 160)}`
const rowsText = rows.map(rowLine).join('\n')
const missedText = missed.map(m => `## ${m.subsystem}\n` + (m.missed_findings || []).map(x => `- [${x.severity}] ${x.title} (${x.file}) — ${x.evidence?.slice(0, 120)}`).join('\n')).join('\n\n')

const synthChunks = rowsText.length > 90000 ? rowsText.match(/[\s\S]{1,90000}/g) : [rowsText]
const synthInput = synthChunks.length > 1 ? synthChunks[0] + `\n\n[NOTE: ${synthChunks.length - 1} additional chunk(s) of rows omitted from this view for length; ${rows.length} total adjudications were performed — reason over the visible sample plus the aggregate counts below.]` : rowsText

let plan
try {
  plan = await withRetry(() => agent(
    `You are grading a prior production-readiness audit by the results of an independent, partly execution-grounded re-audit of the repo at ${REPO}.

Each row: original audit verdict | independent re-check | adversarial adjudication (execution-* provenance = actually ran code). ${rows.length} findings re-audited; ${execGrounded} settled by execution.

Produce:
- audit_trust_grade (A-F) for the ORIGINAL audit, justified by the agreement rate and the nature of any disagreements (an execution-grounded overturn is far more damning than a reasoning disagreement).
- executive_summary.
- agreement {total, agreed, overturned, execution_grounded}.
- false_positives: original said confirmed but the re-audit refutes (weight execution-refuted heavily).
- false_negatives: original refuted/unverified or missed, but the re-audit confirms real (include the recall-pass missed findings below). DEDUP GUARD: before listing a recall "missed" item as a false negative, check it against the adjudicated finding ids/titles above — if the audit ALREADY has a finding for the same mechanism (even under a different id/severity/framing), it is NOT a miss; drop it. A "missed" item that restates a confirmed finding is a recall-pass artifact, not an audit failure.
- severity_corrections.
- themes: patterns in where/why the audit erred (e.g., a finding class it systematically over- or under-rated).

Be concrete, cite ids. Invent nothing.

ADJUDICATIONS:
${synthInput}

RECALL PASS — candidate MISSED findings:
${missedText || '(none surfaced)'}`,
    { label: 'meta-synthesis', phase: 'Synthesis', model: verifierModel, schema: SYNTH_SCHEMA }
  ))
} catch (e) {
  log(`ERROR: synthesis failed (${e?.message || e}) — returning raw adjudications so the data survives.`)
  plan = { error: 'synthesis-failed', message: String(e?.message || e) }
}

return {
  repo: REPO,
  audited_findings: rows.length,
  execution_grounded: execGrounded,
  overturned: rows.filter(r => r.adj?.overturns_recheck).length,
  missed_candidate_count: missedCount,
  grade: plan?.audit_trust_grade,
  plan,
  rows: rows.map(r => ({
    id: r.id, severity: r.severity, audit_verdict: r.verdict, verify_class: r.verify_class,
    recheck_verdict: r.recheck?.meta_verdict, recheck_verdict_ok: r.recheck?.original_verdict_correct,
    recheck_severity: r.recheck?.severity_assessment,
    final_verdict: r.adj?.final_meta_verdict, provenance: r.adj?.provenance || r.adj?.method,
    overturns: r.adj?.overturns_recheck, severity_final: r.adj?.severity_final,
    reproduction: r.adj?.reproduction || null,
    reasoning: r.adj?.reasoning,
  })),
  missed,
}
