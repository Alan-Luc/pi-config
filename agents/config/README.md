# Role-scoped MCP setup

Run this explicit one-time setup against a disposable isolated Pi config root; never pass the canonical `~/.pi/agent` root:

```sh
python3 agents/config/initialize-mcp.py /absolute/path/to/isolated-pi-config
```

The initializer merges only the bundled `codesearch` and `gitlab` server entries into the target `mcp.json`, preserving unrelated settings and server entries. It retains the Authorization environment reference literally; it never reads or prints the token value. The `code-explorer` profile is statically limited to the four supplied codesearch native names, denies `mcp` and generic resource names, and denies inheritance of the GitLab token.

The initializer also creates or updates `agents/mr-babysitter.md` from the bundled role template. It reads `agents/config/gitlab-read-tools.json` inside the target root if present; otherwise it uses this directory's manifest. The bundled manifest selects the advertised `get_merge_request` and `get_merge_request_diffs` operations only. Their runtime effects, identity and authorization remain untested. Empty or revoked approvals leave the MR profile at `flags: --no-mcp` and restore token denial. Additional entries require an explicit operator choice of exact `mcp__gitlab__<name>` values. The initializer validates names and emits only those names in the profile's MCP allowlist, removes the `--no-mcp` flag, and removes only `GITLAB_PERSONAL_ACCESS_TOKEN` from that role's env deny list. It always excludes `mcp` and generic resource tools.

Name validation is not proof that an operation is read-only, and tool filtering is not proof of server-side authorization or runtime isolation. Confirm each approved operation's semantics before adding it. The MR role uses `inject-skills: mr-babysit` so its explicit invocation receives the workflow body; the skill itself is command-only. Setup preserves an existing role's model, effort, extra tool denials and directory permissions. It uses unique private temporary files in the destination directory and atomic replacement. It writes no credentials and creates no auth copies or symlinks.

Alan's later isolated runtime test must verify role loading, skill injection, MCP startup, direct and indirect calls, and resource/proxy exclusion. This initializer does not perform those checks or contact services.
