# Guardrails threat model

These checks reduce mistakes by otherwise well-intentioned agents; they are not a sandbox against malicious code running as the same account.

## Covered surface

The guard checks literal Git mutations on supported `bash` and `bg_run` command surfaces, including nested tool calls. It blocks child-agent commits and pushes, routes non-GitHub parent pushes through the explicit publication gate, and keeps `verification_evidence` check-only by rejecting recognized direct Git mutations before execution. Preserve the existing recognized rejection cases; this document does not expand command parsing or promise coverage for every way to invoke Git.

Ordinary parent `git push origin <branch>` commands to exclusively `github.com` push URLs bypass publication grants, clearance, and scanners; `-u` / `--set-upstream`, a literal absolute checkout `cd`, and Git `-C` are supported. Effective push URLs include Git URL rewrites and every configured push URL. Force/delete/mirror options, Git configuration overrides, configured mirroring, and recursive submodule pushes do not receive this exception. Alan's explicit push authorization is still required; this exception does not prove verification or server-side protection.

For other hosts, publication branches must start with literal `alan/ENG-` and have a nonempty Git-valid suffix, under an exact matching project/push grant. `TASK-` and other `alan/*` branches are not publication targets.

## Outside the guarantee

Shell wrappers, obfuscation, other execution paths, or hostile same-account code may bypass command inspection. Same-account processes may also inherit ambient SSH keys, credential helpers, or access to servers; this guard does not remove credentials or enforce server-side branch policy. Server protections and withholding child credentials must be established independently where required, not inferred from these checks.

Dismiss a proposed bypass as out of model only when its triggering input is wrapped, obfuscated, or otherwise outside the supported literal command surface, and state that reason explicitly. A literal recognized mutation on a covered surface remains in model and must satisfy its authorization rules. An unverified credential or server-protection assumption is a gap, not an out-of-model dismissal.
