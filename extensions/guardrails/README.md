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

## Configure publication

Keep Alan's explicit authorization separate from proof and target configuration.
Chat approval does not create a grant or skip a prerequisite.
Alan must provide an enabled external grant matching `publication-grant.schema.json`.
Keep the grant and scanner configuration outside the repository.
Store the GitLab credential in the grant's named environment variable before starting Pi.
The resolver does not use `glab`'s stored credentials.

Set `PI_PUBLICATION_CONFIG_PATH` before startup, or run `/publication-config` and select an existing absolute grant path in the native dialog.
The command validates the existing schema and selects the path for this session only.
It does not create grants, change environment variables, persist settings, install scanners, seal proof, or push.
Cancellation and invalid selections preserve the prior path.
Session replacement and shutdown discard the selection.
Children and sessions without native UI cannot select a grant.

Use the exact single effective URL from `git remote get-url --push --all origin` as `pushUrl`.
Keep the approved scanner executable, version, and configuration hashes pinned in the grant.
Compute `scannerId` as SHA-256 of the executable SHA-256, trimmed version output, and configuration SHA-256, separated by newlines without a final newline.
Missing scanner provisioning requires separate authorization; approval does not replace scanning.

After the final commit, complete the required independent lanes and collect fresh postcommit verification evidence.
Copy each finalized report's `Publication lane: childId=... incarnationId=...` values into `publication_clearance`.
IDs select authoritative registry records; the report alone does not prove clearance.
Then submit the separately authorized standalone `git push origin <branch>`.
A refusal names the missing prerequisite without starting transport.
Resolve that prerequisite rather than repeating the same blocked push.
No live publication readiness follows from configuration selection alone.

## Outside the guarantee

Shell wrappers, obfuscation, other execution paths, and hostile same-account code may bypass command inspection.
Same-account processes may inherit ambient SSH keys, credential helpers, or access to servers.
This guard neither removes credentials nor enforces server-side branch policy.
Where required, establish server protections and withhold child credentials independently.

Dismiss a bypass as out of model only for wrapped, obfuscated, or otherwise unsupported literal-command inputs.
State that reason explicitly.
A literal recognized mutation on a covered surface remains in model and must satisfy its authorization rules.
An unverified credential or server-protection assumption is a gap, not an out-of-model dismissal.
