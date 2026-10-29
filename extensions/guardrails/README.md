# Guardrails threat model

These checks reduce mistakes by otherwise well-intentioned agents; they are not a sandbox against malicious code running as the same account.

## Covered surface

The guard checks literal Git mutations on supported `bash` and `bg_run` command surfaces, including nested tool calls. It blocks child-agent commits and pushes, restricts parent pushes to the explicit publication gate, and keeps `verification_evidence` check-only by rejecting recognized direct Git mutations before execution. Preserve the existing recognized rejection cases; this document does not expand command parsing or promise coverage for every way to invoke Git.

## Outside the guarantee

Shell wrappers, obfuscation, other execution paths, or hostile same-account code may bypass command inspection. Same-account processes may also inherit ambient SSH keys, credential helpers, or access to servers; this guard does not remove credentials or enforce server-side branch policy. Server protections and withholding child credentials must be established independently where required, not inferred from these checks.

Dismiss a proposed bypass as out of model only when its triggering input is wrapped, obfuscated, or otherwise outside the supported literal command surface, and state that reason explicitly. A literal recognized mutation on a covered surface remains in model and must satisfy its authorization rules. An unverified credential or server-protection assumption is a gap, not an out-of-model dismissal.
