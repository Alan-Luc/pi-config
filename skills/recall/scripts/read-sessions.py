#!/usr/bin/env python3
"""Read bounded Pi session metadata or cited excerpts from one workspace directory."""
import argparse
import json
import os
from pathlib import Path
from datetime import datetime, timezone

CHILD_MARKER = "pi-subagents_launch_metadata"
DEFAULT_FILE_BYTES = 2 * 1024 * 1024
DEFAULT_OUTPUT_BYTES = 32 * 1024


def iso_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def source_version(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def load(path, max_bytes):
    if path.is_symlink() or not path.is_file():
        raise ValueError("session source is not a regular file")
    before = path.stat()
    if before.st_size > max_bytes:
        raise ValueError(f"session exceeds byte limit ({before.st_size} > {max_bytes})")
    version = source_version(before)
    with path.open("rb") as stream:
        if source_version(os.fstat(stream.fileno())) != version:
            raise ValueError("session changed before being read")
        content = stream.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise ValueError(f"session exceeds byte limit ({max_bytes}) while being read")
        if source_version(os.fstat(stream.fileno())) != version:
            raise ValueError("session changed while being read")
    if source_version(path.stat()) != version:
        raise ValueError("session changed while being read")
    entries, malformed = [], 0
    for line_number, line in enumerate(content.splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            malformed += 1
            continue
        if not isinstance(value, dict):
            malformed += 1
            continue
        entries.append((line_number, value))
    header = entries[0][1] if entries else None
    if not isinstance(header, dict) or header.get("type") != "session" or not isinstance(header.get("id"), str):
        return None, [], malformed + 1
    return header, entries[1:], malformed


def subagent_metadata(entries):
    for _, entry in entries:
        if entry.get("type") != "custom" or entry.get("customType") != CHILD_MARKER:
            continue
        data = entry.get("data")
        if isinstance(data, dict) and data.get("version") == 1 and isinstance(data.get("name"), str) and data.get("mode") in ("interactive", "background"):
            return data
    return None


def get_text(entry):
    if entry.get("type") != "message":
        return ""
    message = entry.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                if not isinstance(block.get("text"), str):
                    raise ValueError("message text block must contain string text")
                parts.append(block["text"])
        return " ".join(parts)
    return ""


def path_for_leaf(entries):
    by_id = {}
    for _, entry in entries:
        entry_id = entry.get("id")
        parent_id = entry.get("parentId")
        if not isinstance(entry_id, str) or not entry_id or "parentId" not in entry or (parent_id is not None and not isinstance(parent_id, str)):
            return [], "broken-or-cyclic-parent-chain"
        if entry_id in by_id:
            return [], "broken-or-cyclic-parent-chain"
        by_id[entry_id] = entry
    if not by_id:
        return [], "empty"
    leaf_id = next(reversed(by_id))
    result, seen = [], set()
    current = by_id.get(leaf_id)
    while current is not None:
        entry_id = current.get("id")
        if not isinstance(entry_id, str) or entry_id in seen:
            return [], "broken-or-cyclic-parent-chain"
        seen.add(entry_id)
        result.append(current)
        parent_id = current.get("parentId")
        if parent_id is None:
            break
        if not isinstance(parent_id, str) or parent_id not in by_id:
            return [], "broken-or-cyclic-parent-chain"
        current = by_id[parent_id]
    result.reverse()
    return result, "last-persisted-entry-leaf"


def resolve_scope(args, parser):
    current_id = args.current_session_id or os.environ.get("PI_SESSION_ID")
    if not current_id:
        parser.error("provide --current-session-id or PI_SESSION_ID")
    workspace = Path(args.workspace).expanduser().resolve()
    raw_session_dir = Path(args.session_dir).expanduser()
    if raw_session_dir.is_symlink():
        parser.error("--session-dir must not be a symlink")
    session_dir = raw_session_dir.resolve()
    if not session_dir.is_dir():
        parser.error("--session-dir must be an existing non-symlink directory")
    return current_id, workspace, session_dir


def excluded(path, session_id, args):
    if session_id == args.current_session_id:
        return "current-session"
    if session_id in args.exclude_session_id:
        return "caller-excluded"
    resolved = path.resolve()
    if any(resolved == Path(item).expanduser().resolve() for item in args.exclude_path):
        return "caller-excluded"
    if any(resolved.is_relative_to(Path(item).expanduser().resolve()) for item in args.exclude_root):
        return "caller-excluded"
    return None


def add_common(parser):
    parser.add_argument("--session-dir", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--current-session-id")
    parser.add_argument("--exclude-session-id", action="append", default=[])
    parser.add_argument("--exclude-path", action="append", default=[])
    parser.add_argument("--exclude-root", action="append", default=[])
    parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_FILE_BYTES)
    parser.add_argument("--max-output-bytes", type=int, default=DEFAULT_OUTPUT_BYTES)


def run_list(args, parser):
    current_id, workspace, session_dir = resolve_scope(args, parser)
    args.current_session_id = current_id
    if args.max_file_bytes < 1 or args.max_output_bytes < 1 or args.max_output_bytes > 1024 * 1024 or args.max_files < 1 or args.max_files > 500:
        parser.error("file and session bounds must be positive; --max-files cannot exceed 500")
    files = sorted(session_dir.glob("*.jsonl"))
    omissions, sessions = [], []
    if len(files) > args.max_files:
        omissions.append({"reason": "session-count-bound", "omitted": len(files) - args.max_files})
        files = files[:args.max_files]
    for path in files:
        if path.is_symlink() or not path.is_file():
            omissions.append({"path": str(path), "reason": "unsafe-or-missing-file"})
            continue
        try:
            header, entries, malformed = load(path, args.max_file_bytes)
        except (OSError, ValueError) as error:
            omissions.append({"path": str(path), "reason": str(error)})
            continue
        if header is None:
            omissions.append({"path": str(path), "reason": "malformed-or-missing-header"})
            continue
        if not isinstance(header.get("cwd"), str) or not header["cwd"] or Path(header["cwd"]).expanduser().resolve() != workspace:
            omissions.append({"path": str(path), "session_id": header["id"], "reason": "workspace-mismatch"})
            continue
        reason = excluded(path, header["id"], args)
        if reason:
            omissions.append({"path": str(path), "session_id": header["id"], "reason": reason})
            continue
        metadata = subagent_metadata(entries)
        if header.get("parentSession") and metadata:
            omissions.append({"path": str(path), "session_id": header["id"], "reason": "known-subagent"})
            continue
        timestamps = [iso_time(entry.get("timestamp")) for _, entry in entries]
        valid = [value for value in timestamps if value is not None]
        last = max(valid) if valid else iso_time(header.get("timestamp"))
        sessions.append({"session_id": header["id"], "path": str(path), "cwd": header["cwd"], "parent_session": header.get("parentSession"), "lineage": "parent-session-recorded" if header.get("parentSession") else ("launch-marker-without-parent-unknown" if metadata else "no-parent-session-recorded"), "activity": datetime.fromtimestamp(last, timezone.utc).isoformat().replace("+00:00", "Z") if last is not None else None, "activity_basis": "latest-valid-entry-timestamp" if valid else "header-timestamp-fallback", "entries": len(entries), "malformed_lines": malformed})
    sessions.sort(key=lambda item: item["activity"] or "", reverse=True)
    output = json.dumps({"sessions": sessions, "omissions": omissions, "scope": {"workspace": str(workspace), "session_dir": str(session_dir), "current_session_id": current_id}}, ensure_ascii=False)
    if len(output.encode("utf-8")) > args.max_output_bytes:
        parser.error(f"metadata exceeds output byte limit ({args.max_output_bytes})")
    print(output)


def run_extract(args, parser):
    current_id, workspace, session_dir = resolve_scope(args, parser)
    raw_path = Path(args.session_file).expanduser()
    if raw_path.is_symlink():
        parser.error("--session-file must not be a symlink")
    path = raw_path.resolve()
    if path.parent != session_dir:
        parser.error("--session-file must be directly inside --session-dir")
    if args.max_file_bytes < 1 or args.max_output_bytes < 1 or args.max_output_bytes > 1024 * 1024:
        parser.error("byte bounds must be positive; output limit cannot exceed 1 MiB")
    try:
        header, entries, malformed = load(path, args.max_file_bytes)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    if header is None:
        parser.error("malformed-or-missing-header")
    if header["id"] == current_id:
        parser.error("refusing to extract the current session")
    if header.get("id") in args.exclude_session_id or path in [Path(item).expanduser().resolve() for item in args.exclude_path] or any(path.is_relative_to(Path(item).expanduser().resolve()) for item in args.exclude_root):
        parser.error("session is caller-excluded")
    if not isinstance(header.get("cwd"), str) or not header["cwd"] or Path(header["cwd"]).expanduser().resolve() != workspace:
        parser.error("session workspace does not match --workspace")
    metadata = subagent_metadata(entries)
    if header.get("parentSession") and metadata:
        parser.error("refusing known subagent session")
    branch, leaf_basis = path_for_leaf(entries)
    if leaf_basis == "broken-or-cyclic-parent-chain":
        parser.error("session has a broken or cyclic parent chain")
    since = iso_time(args.since) if args.since else None
    if args.since and since is None:
        parser.error("--since must be an ISO timestamp")
    topic = args.topic.casefold().split() if args.topic else []
    excerpts = []
    encoded = 0
    for item in branch:
        text = get_text(item).strip()
        if not text:
            continue
        timestamp = item.get("timestamp")
        when = iso_time(timestamp)
        if since is not None and (when is None or when < since):
            continue
        if topic and not all(word in text.casefold() for word in topic):
            continue
        citation = f'{header["id"]}#{item["id"]}'
        excerpt = {"entry_id": item["id"], "timestamp": timestamp, "role": item.get("message", {}).get("role"), "text": text, "citation": citation}
        size = len(json.dumps(excerpt, ensure_ascii=False).encode("utf-8"))
        if encoded + size > args.max_output_bytes:
            parser.error(f"excerpts exceed output byte limit ({args.max_output_bytes})")
        encoded += size
        excerpts.append(excerpt)
    activity_times = [iso_time(entry.get("timestamp")) for _, entry in entries]
    valid = [value for value in activity_times if value is not None]
    activity = datetime.fromtimestamp(max(valid), timezone.utc).isoformat().replace("+00:00", "Z") if valid else header.get("timestamp")
    output = json.dumps({"session_id": header["id"], "cwd": header["cwd"], "parent_session": header.get("parentSession"), "lineage": "parent-session-recorded" if header.get("parentSession") else ("launch-marker-without-parent-unknown" if metadata else "no-parent-session-recorded"), "activity": activity, "activity_basis": "latest-valid-entry-timestamp" if valid else "header-timestamp-fallback", "extraction_branch": leaf_basis, "excerpts": excerpts, "malformed_lines": malformed, "omissions": ["malformed-lines-skipped"] if malformed else []}, ensure_ascii=False)
    if len(output.encode("utf-8")) > args.max_output_bytes:
        parser.error(f"result exceeds output byte limit ({args.max_output_bytes})")
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="list bounded session metadata in one workspace directory")
    add_common(listing)
    listing.add_argument("--max-files", type=int, default=100)
    listing.set_defaults(run=run_list)
    extract = commands.add_parser("extract", help="extract bounded cited excerpts from one session")
    add_common(extract)
    extract.add_argument("--session-file", required=True)
    extract.add_argument("--since")
    extract.add_argument("--topic")
    extract.set_defaults(run=run_extract)
    args = parser.parse_args()
    try:
        args.run(args, parser)
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
