# repo-audit

A reusable, verification-grounded **production-readiness audit** for any code repository.

Point it at a repo and it profiles the codebase, fans specialist agents across universal and auto-detected domain lenses, executes real analyzers where it is allowed to, **verifies every finding by the strongest oracle available** (execution where a claim is falsifiable, stronger-tier reasoning where it is judgment), provenance-weights the survivors, and triages everything into a go/no-go scorecard.

It is a [Claude Code](https://claude.com/claude-code) **workflow** — a deterministic multi-agent orchestration script. It runs dozens of subagents in parallel under a fixed control flow, rather than letting a single model decide what to look at.

## Design principles

- **Verdicts are three-state, never silent.** Every finding ends as `confirmed`, `refuted`, or `unverified`. A verifier that stalls, errors, or returns nothing marks the finding **unverified** (needs a human) — it is never silently dropped or auto-refuted. A real bug behind a bad reproduction stays unverified, not refuted.
- **Route by oracle strength.** A claim that a test or PoC could settle is verified by *execution* (when enabled in a sandbox). A judgment claim — maintainability, methodology, architecture, an absent control — is verified by *reasoning*, and high-severity judgment findings are escalated to a stronger model.
- **Provenance is weighted, not flattened.** Trust order: `execution-confirmed > tool-reported > stronger-tier-agreed > single-model-inspection > unverified`. An execution- or tool-confirmed critical can hard-RED a category; a critical that is only single-model inspection becomes **NEEDS-HUMAN**, not an automatic RED.
- **Maximize recall, then filter.** Framed dimensions, an unframed sweep, a completeness critic hunting for what every prior pass missed, a business-logic pass (does each feature/control actually do what it claims), and a cross-subsystem seam pass — then verification does the precision work.
- **Resist the additive default.** The improvement pass is biased toward *reduction* — deleting, inlining, collapsing — and ranks net-lines-removed as a feature.

## Phases

`Profile → Recon → Audit → Sweep → Critic → BizLogic → Improve → Readiness → Seam → GroundTruth → Verify → Plan`

| Phase | What it does |
|---|---|
| **Profile** | Discover language, kind, domain, 3–6 subsystems, deps, test command; semantically select applicable domain lenses |
| **Recon** | Deep-map each subsystem (purpose, entry points, external I/O, risks) |
| **Audit** | Universal framed dimensions: security, quality, correctness, deps, tests |
| **Sweep** | Unframed open-ended review per subsystem — maximize recall |
| **Critic** | Completeness critic hunts for what every prior pass missed (negative space, absent classes) |
| **BizLogic** | Intent-vs-implementation: does each feature/control/claim actually do what it says |
| **Improve** | Opportunities, biased toward reductive (delete/simplify) |
| **Readiness** | NFR lenses — resilience, auditability, ops/cost — plus selected domain lenses |
| **Seam** | Cross-subsystem interface code: producer/consumer contracts, trust boundaries, field-name mismatches |
| **GroundTruth** | Execute language-appropriate analyzers (linters, type checkers, security scanners, dep audit, tests) — gated by `trustLevel` |
| **Verify** | Route each finding by oracle; provenance-stamp; never silent-refute |
| **Plan** | Recalibrate severity to one rubric, dedup, triage, provenance-weighted GREEN/YELLOW/RED scorecard |

## Usage

From Claude Code, invoke the workflow with at minimum a `repoRoot`:

```
Workflow({ name: "repo-audit", args: { repoRoot: "/abs/path/to/repo" } })
```

### Arguments

| Arg | Default | Meaning |
|---|---|---|
| `repoRoot` | *(required)* | Absolute path to the repo to audit |
| `fanout` | `auto` | `auto` (picks economy vs standard by repo size — repos > 30 source files use batched verification to control cost) · `quick` (framed only) · `economy` (batched cheap verify) · `standard` (per-finding verify) · `thorough` (3-vote verification) |
| `domainLenses` | *(auto)* | Explicit lens keys to force; otherwise the profiler picks |
| `skipLenses` | `[]` | Lens/dimension keys to skip |
| `workerModel` | `sonnet` | Finders + falsifiable/cheap verification |
| `verifierModel` | `opus` | High-severity judgment-finding verification |
| `trustLevel` | `trusted` | `trusted` runs analyzers/tests; `untrusted` is **inspection only, no code execution** |
| `executeVerification` | `false` | Execution-grounded verification (writes & runs repro code — **needs a sandbox**). Two-gate: a behavior must both *manifest* and be a *genuine defect* to confirm |
| `sandboxed` | `false` | Assert the auditor runs in a sandbox/disposable checkout. Turns `executeVerification` on by default (explicit `executeVerification:false` still wins) |
| `maxOutputTokens` | *(none)* | Fleet-level output-token cap; once hit, not-yet-started passes are skipped so synthesis still runs. Also respects the turn-level budget directive |
| `hierarchicalSynthesis` | `false` | Per-category sub-synthesis before the meta pass (experimental; for very large audits) |

### Trust & safety

- **`trustLevel: "untrusted"` is required for any repo you do not trust.** It disables all code execution (no analyzers, no tests, no execution verification) and audits by inspection only.
- `executeVerification` and `hierarchicalSynthesis` are opt-in and validated only lightly — enable them when you can run the auditor itself containerized (or pass `sandboxed:true`).
- **Read-only enforcement.** Finder/recon agents are *told* to observe only, but that is a prompt-level request — spawned agents still hold Write/Edit. To enforce it at the harness level, wire the PreToolUse hook at [`hooks/readonly-guard.py`](hooks/readonly-guard.py) and set `REPO_AUDIT_GUARD=/abs/path/to/repo-under-audit` for the session running the audit; it blocks any Write/Edit/MultiEdit/NotebookEdit inside the guarded root. No-op when the env var is unset, so it is safe to leave wired. (Per-agent tool denial is not exposed by the workflow API, so the hook is the enforcement point.)
- **Cost:** `maxOutputTokens` / the turn budget bound *total* spend, but the workflow API exposes no per-agent token ceiling, so a single runaway agent cannot be hard-capped. Prefer `economy`/`auto` fanout for large repos.
- **Audit current code.** The profiler now reports `git_status`; if the checkout is behind its remote the run warns you (we once audited a month-stale clone and flagged an already-fixed bug). `git fetch`/pull before auditing.
- **Keep the host awake** for large runs (`caffeinate -dimsu` / on AC) — host sleep suspends the run and balloons wall-clock.

## Output

The workflow returns a structured object:

- `profile` — language, kind, domain, subsystems, selected lenses, run config
- `total_findings`, `confirmed_count`, `refuted_count`, `unverified_count`, `execution_confirmed_count`
- `by_source` — finding counts per pass
- `plan` — executive summary, **scorecard** (one row per category with verdict + bar-to-clear + blocking IDs), full **triage** (every finding, merged & dispositioned), **prioritized_actions** (defects), **opportunities** (improvements, ranked separately), **quick_wins**, **themes**
- `all_findings` — every finding with verdict, provenance, verifier reasoning, and any reproduction

## Operational notes

- **Keep the host awake.** Each subagent is a process; if the machine sleeps mid-run (closed lid on battery, idle sleep), the whole audit suspends and wall-clock balloons. Run on AC with the lid open, or hold it awake with `caffeinate -dimsu` (macOS). This is the single biggest determinant of how long a run takes.
- **Cost scales with fan-out.** `auto` keeps larger repos on batched verification for this reason. For a paid/API deployment, prefer `economy`, and treat a full `standard`/`thorough` run on a large repo as a deliberate (expensive) choice.

## meta-audit — auditing the audit

[`meta-audit.js`](meta-audit.js) is a companion workflow that grades a `repo-audit` result. For each finding it independently re-derives the claim from the real code, then **adversarially verifies by oracle**: falsifiable findings are settled by *writing and running a repro* (execution-confirmed / -refuted), judgment findings by stronger-tier adversarial reasoning. It adds a per-subsystem recall pass for findings the audit missed, then grades the original audit **A–F** with false-positive / false-negative / severity-correction lists.

```
Workflow({ scriptPath: ".../meta-audit.js", args: {
  repo: "/abs/path/to/repo",
  inputJsonl: "findings.jsonl",   // one finding per line (from a repo-audit all_findings dump)
  indexPath:  "index.json"         // { repo, subsystems, index:[{id,severity,verdict,verify_class,file,blocking}] }
}})
```

Use it to establish trust in an audit (it execution-confirmed this engine's flagship findings) — but note its recall pass is only as good as its dedup against the original findings.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
