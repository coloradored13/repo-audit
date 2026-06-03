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
| `fanout` | `standard` | `quick` (framed only) · `economy` (batched cheap verify) · `standard` · `thorough` (3-vote verification) |
| `domainLenses` | *(auto)* | Explicit lens keys to force; otherwise the profiler picks |
| `skipLenses` | `[]` | Lens/dimension keys to skip |
| `workerModel` | `sonnet` | Finders + falsifiable/cheap verification |
| `verifierModel` | `opus` | High-severity judgment-finding verification |
| `trustLevel` | `trusted` | `trusted` runs analyzers/tests; `untrusted` is **inspection only, no code execution** |
| `executeVerification` | `false` | Execution-grounded verification (writes & runs repro code — **needs a sandbox**) |
| `hierarchicalSynthesis` | `false` | Per-category sub-synthesis before the meta pass (experimental; for very large audits) |

### Trust & safety

- **`trustLevel: "untrusted"` is required for any repo you do not trust.** It disables all code execution (no analyzers, no tests, no execution verification) and audits by inspection only.
- `executeVerification` and `hierarchicalSynthesis` are opt-in and validated only lightly — enable them when you can run the auditor itself containerized.
- The auditor's finder/recon agents are instructed to observe only and not modify the target repo. This is currently a prompt-level instruction, not a hard gate; run inside a sandbox or a disposable checkout if write-isolation matters to you.

## Output

The workflow returns a structured object:

- `profile` — language, kind, domain, subsystems, selected lenses, run config
- `total_findings`, `confirmed_count`, `refuted_count`, `unverified_count`, `execution_confirmed_count`
- `by_source` — finding counts per pass
- `plan` — executive summary, **scorecard** (one row per category with verdict + bar-to-clear + blocking IDs), full **triage** (every finding, merged & dispositioned), **prioritized_actions** (defects), **opportunities** (improvements, ranked separately), **quick_wins**, **themes**
- `all_findings` — every finding with verdict, provenance, verifier reasoning, and any reproduction

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
