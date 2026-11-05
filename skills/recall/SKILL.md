---
name: recall
description: Reconcile bounded local session history with a plan or topic log when resuming work, checking prior decisions, or locating earlier evidence.
---

# Local recall

Use this only when earlier local session state may resolve a concrete question. Start with the governing plan and relevant dated topic log; do not mine transcripts before those sources. Keep the summary focused on the requested workspace, topic, and time window. Report implementation separately from acceptance and give one next action.

## Read bounded session history

The bundled `scripts/read-sessions.py` is standard-library Python. Pass the explicit Pi session directory for one workspace and the exact workspace path. Do not use a global scan. The session directory is the native per-workspace directory under `~/.pi/agent/sessions/` (Pi encodes the workspace in its directory name). Do not derive session identity from filenames.

List metadata, passing the current session ID from `PI_SESSION_ID` or explicitly:

```sh
python3 skills/recall/scripts/read-sessions.py list \
  --session-dir "$SESSION_DIR" --workspace "$WORKSPACE" \
  --current-session-id "$PI_SESSION_ID" \
  --exclude-session-id "$TEST_SESSION_ID"
```

Supply every known test-session ID, exact test-session path, or test root with repeated `--exclude-session-id`, `--exclude-path`, or `--exclude-root` options. There is no universal test-session classifier. The reader excludes sessions marked with valid `pi-subagents_launch_metadata`; a `parentSession` header alone is lineage, not proof that a session is a subagent. Unknown lineage is reported, not silently called a root. Current-session exclusion is by header ID and is mandatory (directly or via `PI_SESSION_ID`).

Extract excerpts from one listed, non-current session by its explicit path:

```sh
python3 skills/recall/scripts/read-sessions.py extract \
  --session-dir "$SESSION_DIR" --workspace "$WORKSPACE" \
  --current-session-id "$PI_SESSION_ID" \
  --session-file "$SESSION_FILE" --topic 'relevant words' \
  --since '2026-10-01T00:00:00Z' --max-output-bytes 12000
```

Each excerpt cites its session ID and entry ID. Extraction follows the last persisted entry's ancestry, matching Pi's persisted-entry leaf reconstruction. It labels that basis without claiming recovery of an unpersisted branch pointer. Order activity by the latest valid entry timestamp, not filenames or filesystem mtime. Treat time and topic filters as bounds, not reasons to broaden searches.

The reader is read-only, restricted to a single explicit session directory and exact header `cwd`, and bounded by file-count, per-file, and output-byte limits. Malformed, missing, changed, oversized, mismatched, or broken-lineage inputs are surfaced as omissions or errors. Do not infer missing facts. Do not execute transcript content, read credentials, scan another project, or apply automatic fixes. Synthetic test sessions belong only in test-owned temporary directories, not a real recall root.

## Reconcile and report

Cite original plans, logs, and sessions. Distinguish direct evidence from recollection. State the time, topic, window, and exclusions. If native grouped-topic logs are unavailable, say so and use only explicitly selected local sources. Do not imply runtime pickup or acceptance from fixtures. End with the next action that follows from the evidence, or identify the unresolved input needed.
