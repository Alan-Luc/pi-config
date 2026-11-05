# Guardrails threat model

These checks reduce mistakes by well-intentioned agents.
They are not a sandbox against malicious code running as the same account.

## Covered surface

The guard checks literal Git mutations on supported `bash` and `bg_run` command surfaces, including nested tool calls.
It blocks child-agent commits and pushes.
It routes parent pushes to hosts other than GitHub through the explicit publication gate.
It keeps `verification_evidence` check-only by rejecting recognized direct Git mutations before execution.
Preserve existing recognized rejection cases.
This document neither expands command parsing nor promises coverage for every way to invoke Git.

If every effective push URL is on `github.com`, ordinary parent `git push origin <branch>` commands bypass publication grants, clearance, and scanners.
Effective push URLs include Git URL rewrites and every configured push URL.
This exception supports `-u`, `--set-upstream`, a literal absolute checkout `cd`, and Git `-C`.
It excludes force, delete, and mirror options, Git configuration overrides, configured mirroring, and recursive submodule pushes.
Alan's explicit push authorization remains required.
The exception proves neither verification nor server-side protection.

For other hosts, publication branches must start with literal `alan/ENG-` and have a nonempty Git-valid suffix.
They require an exact matching project and push grant.
`TASK-` and other `alan/*` branches are not publication targets.

## Outside the guarantee

Shell wrappers, obfuscation, other execution paths, and hostile same-account code may bypass command inspection.
Same-account processes may inherit ambient SSH keys, credential helpers, or access to servers.
This guard neither removes credentials nor enforces server-side branch policy.
Where required, establish server protections and withhold child credentials independently.

Dismiss a bypass as out of model only for wrapped, obfuscated, or otherwise unsupported literal-command inputs.
State that reason explicitly.
A literal recognized mutation on a covered surface remains in model and must satisfy its authorization rules.
An unverified credential or server-protection assumption is a gap, not an out-of-model dismissal.
