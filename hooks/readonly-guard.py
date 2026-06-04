#!/usr/bin/env python3
"""repo-audit read-only guard — a Claude Code PreToolUse hook.

The audit workflow tells its finder/recon agents to observe only, but that is a
prompt-level request, not enforcement: spawned agents still hold Write/Edit. This
hook makes read-only real at the harness level — it BLOCKS any Write/Edit/
MultiEdit/NotebookEdit whose target path falls inside a guarded audit root.

Enable it by setting REPO_AUDIT_GUARD to the repo(s) being audited (os.pathsep-
separated) for the session that runs the audit, e.g.:

    REPO_AUDIT_GUARD=/abs/path/to/repo-under-audit

When the variable is empty/unset, the hook is a no-op, so it is safe to leave
wired in settings.json permanently.

Wire it (settings.json):

    "hooks": {
      "PreToolUse": [
        { "matcher": "Write|Edit|MultiEdit|NotebookEdit",
          "hooks": [ { "type": "command",
                       "command": "python3 /abs/path/to/repo-audit/hooks/readonly-guard.py" } ] }
      ]
    }
"""

import json
import os
import sys

WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # never block on a parse error — fail open, this is a guard not a gate of last resort

    if data.get("tool_name") not in WRITE_TOOLS:
        return 0

    guard = os.environ.get("REPO_AUDIT_GUARD", "").strip()
    if not guard:
        return 0  # disabled

    roots = [os.path.realpath(r) for r in guard.split(os.pathsep) if r.strip()]
    ti = data.get("tool_input") or {}
    fp = ti.get("file_path") or ti.get("notebook_path") or ""
    if not fp:
        return 0

    target = os.path.realpath(fp)
    for root in roots:
        if target == root or target.startswith(root + os.sep):
            sys.stderr.write(
                f"repo-audit read-only guard: BLOCKED {data['tool_name']} to {fp} — it is "
                f"inside a guarded audit root ({root}). The auditor must not modify the "
                f"repo under audit. (Unset REPO_AUDIT_GUARD to allow writes.)\n"
            )
            return 2  # exit code 2 => block; stderr is surfaced to the model

    return 0


if __name__ == "__main__":
    sys.exit(main())
