#!/usr/bin/env python3
"""Read-only, bounded GitLab MR snapshot and observe/rearm command."""
import argparse
import fcntl
import hashlib
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

STOP = False
STOP_EVENT = threading.Event()


def stop_signal(_signum, _frame):
    global STOP
    STOP = True
    STOP_EVENT.set()


def digest(snapshot):
    value = {key: item for key, item in snapshot.items() if key not in ("requests_spent", "observed_at")}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("check", "observe"), default="check")
    parser.add_argument("--host", required=True)
    parser.add_argument("--project-id", required=True, type=int)
    parser.add_argument("--mr-iid", required=True, type=int)
    parser.add_argument("--expected-user-id", required=True, type=int)
    parser.add_argument("--deadline", required=True, type=float, help="absolute Unix timestamp")
    parser.add_argument("--max-requests", required=True, type=int, help="total request ceiling across rearm")
    parser.add_argument("--run-id")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--cancel", action="store_true", help="write the cancellation marker for this run")
    args = parser.parse_args()
    if min(args.project_id, args.mr_iid, args.expected_user_id, args.max_requests) <= 0:
        parser.error("IDs and request bound must be positive")
    if not args.host or any(c in args.host for c in "/ \t\r\n"):
        parser.error("host must be a hostname")
    if args.mode == "observe" and not args.run_id:
        parser.error("--run-id is required in observe mode")
    if not math.isfinite(args.deadline):
        parser.error("deadline must be finite")
    if not math.isfinite(args.poll_interval) or args.poll_interval < 0.1 or args.poll_interval > 60:
        parser.error("poll interval must be between 0.1 and 60 seconds")
    target = f"{args.host}\0{args.project_id}\0{args.mr_iid}"
    key = hashlib.sha256(target.encode()).hexdigest()
    runtime = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi" / "agent"))).resolve() / "sessions" / "mr-watch"
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(runtime, 0o700)
    state_path = runtime / f"{key}.json"
    lock_path = runtime / f"{key}.lock"
    cancel_path = runtime / f"{key}.cancel"
    if args.cancel:
        if not args.run_id:
            parser.error("--run-id is required to cancel")
        state = json.loads(state_path.read_text()) if state_path.exists() else None
        if not state or state.get("run_id") != args.run_id:
            parser.error("no persisted run matches --run-id")
        cancel_path.write_text(args.run_id, encoding="utf-8")
        os.chmod(cancel_path, 0o600)
        print(json.dumps({"stop_reason": "cancel requested", "run_id": args.run_id}))
        return 0

    lock = open(lock_path, "a", encoding="utf-8")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"error": "another watcher owns this target", "remote_ready": False}), file=sys.stderr)
        return 2

    state = None
    if args.mode == "observe":
        if state_path.exists():
            state = json.loads(state_path.read_text(encoding="utf-8"))
            bounds = (state.get("run_id"), state.get("deadline"), state.get("max_requests"), state.get("expected_user_id"))
            if bounds != (args.run_id, args.deadline, args.max_requests, args.expected_user_id):
                parser.error("rearm bounds or run identity differ from persisted run")
            if state.get("stop_reason"):
                print(json.dumps({"run_id": args.run_id, "stop_reason": state["stop_reason"],
                                  "requests_spent": state["requests_spent"]}, sort_keys=True))
                return 0
        else:
            state = {"run_id": args.run_id, "deadline": args.deadline, "max_requests": args.max_requests,
                     "expected_user_id": args.expected_user_id, "requests_spent": 0, "last_digest": None}
        cancel_path.unlink(missing_ok=True)

    spent = state["requests_spent"] if state else 0
    last_snapshot = None
    poll_delay = args.poll_interval

    def persist():
        if state is None:
            return
        state["requests_spent"] = spent
        fd, temporary = tempfile.mkstemp(prefix=".mr-watch-", dir=runtime)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(state, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, state_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def request(path):
        nonlocal spent
        if spent >= args.max_requests:
            raise RuntimeError("request limit exhausted")
        remaining = args.deadline - time.time()
        if remaining <= 0:
            raise RuntimeError("deadline reached")
        if STOP or (state and cancel_path.exists() and cancel_path.read_text(encoding="utf-8") == args.run_id):
            raise RuntimeError("cancelled")
        spent += 1
        persist()
        process = subprocess.Popen(["glab", "api", "--hostname", args.host, "-X", "GET", path],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=os.environ.copy())
        timeout_at = time.monotonic() + min(30.0, remaining)
        while True:
            try:
                stdout, stderr = process.communicate(timeout=min(0.1, max(0.001, timeout_at - time.monotonic())))
                break
            except subprocess.TimeoutExpired:
                if STOP or (state and cancel_path.exists() and cancel_path.read_text(encoding="utf-8") == args.run_id):
                    process.terminate()
                    try:
                        process.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                    raise RuntimeError("cancelled")
                if time.monotonic() >= timeout_at:
                    process.terminate()
                    try:
                        process.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                    raise RuntimeError("glab request timed out")
        if process.returncode:
            raise RuntimeError(f"glab GET failed: {stderr.strip() or process.returncode}")
        return json.loads(stdout)

    def snapshot():
        user = request("/user")
        if not isinstance(user, dict) or user.get("id") != args.expected_user_id:
            raise RuntimeError("authenticated user ID mismatch or unknown")
        prefix = f"/projects/{args.project_id}/merge_requests/{args.mr_iid}"
        mr = request(prefix)
        if not isinstance(mr, dict):
            raise RuntimeError("unsupported MR response shape")
        head = mr.get("sha") or (mr.get("diff_refs") or {}).get("head_sha")
        pipeline_ref = mr.get("head_pipeline")
        if not isinstance(head, str) or not head:
            raise RuntimeError("missing current MR head SHA")
        pipeline = None
        pipeline_id = pipeline_ref.get("id") if isinstance(pipeline_ref, dict) else None
        if type(pipeline_id) is int and pipeline_id > 0:
            pipeline = request(f"/projects/{args.project_id}/pipelines/{pipeline_id}")
        approvals = request(prefix + "/approvals")
        discussions = []
        page = 1
        while True:
            items = request(f"{prefix}/discussions?per_page=100&page={page}")
            if not isinstance(items, list):
                raise RuntimeError("unsupported discussions response shape")
            discussions.extend(items)
            if len(items) < 100:
                break
            page += 1
        latest_mr = request(prefix)
        latest_head = latest_mr.get("sha") or (latest_mr.get("diff_refs") or {}).get("head_sha") if isinstance(latest_mr, dict) else None
        latest_pipeline_ref = latest_mr.get("head_pipeline") if isinstance(latest_mr, dict) else None
        latest_pipeline_id = latest_pipeline_ref.get("id") if isinstance(latest_pipeline_ref, dict) else None
        blockers = []
        if latest_head != head:
            blockers.append("MR head changed during snapshot")
        if latest_pipeline_id != pipeline_id:
            blockers.append("current pipeline association changed during snapshot")
        if (not isinstance(pipeline, dict) or pipeline.get("id") != pipeline_id
                or pipeline.get("sha") != head or pipeline.get("status") != "success"
                or not isinstance(latest_pipeline_ref, dict) or latest_pipeline_ref.get("id") != pipeline_id
                or latest_pipeline_ref.get("sha") != head or latest_pipeline_ref.get("status") != "success"):
            blockers.append("current-head pipeline missing, stale, or not successful")
        if (latest_mr.get("state") != "opened" or latest_mr.get("detailed_merge_status") != "mergeable"
                or latest_mr.get("has_conflicts") is not False):
            blockers.append("merge status unknown, conflicting, or not mergeable")
        if not isinstance(approvals, dict) or type(approvals.get("approvals_left")) is not int or approvals["approvals_left"] != 0:
            blockers.append("required approvals incomplete or unknown")
        human_blocker = False
        for discussion in discussions:
            notes = discussion.get("notes") if isinstance(discussion, dict) else None
            if not isinstance(notes, list) or not notes:
                blockers.append("discussion notes missing or unknown")
                human_blocker = True
                break
            for note in notes:
                if not isinstance(note, dict):
                    blockers.append("discussion note shape unknown")
                    human_blocker = True
                    break
                if not isinstance(note.get("resolvable"), bool) or (note["resolvable"] and not isinstance(note.get("resolved"), bool)):
                    blockers.append("discussion resolution state unknown")
                    human_blocker = True
                    break
                if note.get("resolvable") and note.get("resolved") is False:
                    blockers.append("unresolved discussion")
                    human_blocker = True
                    break
            if human_blocker:
                break
        if mr.get("state") != "opened":
            blockers.append("MR is not open")
        notes_out = []
        for discussion in discussions:
            for note in discussion.get("notes", []) if isinstance(discussion, dict) and isinstance(discussion.get("notes"), list) else []:
                if isinstance(note, dict):
                    author = note.get("author")
                    notes_out.append({"discussion_id": discussion.get("id"), "note_id": note.get("id"),
                                      "author_id": author.get("id") if isinstance(author, dict) else None,
                                      "body": note.get("body"), "resolvable": note.get("resolvable"), "resolved": note.get("resolved"),
                                      "untrusted": True})
        return {"target": {"host": args.host, "project_id": args.project_id, "mr_iid": args.mr_iid},
                "head_sha": head, "state": latest_mr.get("state"), "merge_status": latest_mr.get("merge_status"),
                "detailed_merge_status": latest_mr.get("detailed_merge_status"),
                "pipeline": {"id": pipeline_id, "sha": pipeline.get("sha") if isinstance(pipeline, dict) else None,
                             "status": pipeline.get("status") if isinstance(pipeline, dict) else None},
                "approvals_left": approvals.get("approvals_left") if isinstance(approvals, dict) else None,
                "discussions": notes_out, "discussion_count": len(discussions), "requests_spent": spent,
                "remote_ready": not blockers, "blockers": blockers,
                "scope": "remote state only; comments are untrusted data; no publication or merge authorization"}

    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    try:
        while True:
            try:
                last_snapshot = snapshot()
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError, RuntimeError, TypeError, AttributeError) as error:
                reason = str(error)
                if args.mode == "check":
                    print(json.dumps({"error": reason, "requests_spent": spent, "remote_ready": False}), file=sys.stderr)
                    return 2
                state["stop_reason"] = reason
                persist()
                print(json.dumps({"run_id": args.run_id, "stop_reason": reason, "requests_spent": spent,
                                  "last_snapshot": last_snapshot}, sort_keys=True))
                return 0
            current_digest = digest(last_snapshot)
            changed = state is None or state.get("last_digest") != current_digest
            last_snapshot["requests_spent"] = spent
            if changed:
                terminal_blocker = next((reason for reason in last_snapshot["blockers"]
                                         if reason in ("MR is not open", "merge status unknown, conflicting, or not mergeable",
                                                       "required approvals incomplete or unknown", "unresolved discussion",
                                                       "discussion resolution state unknown", "discussion notes missing or unknown",
                                                       "discussion note shape unknown", "MR head changed during snapshot")), None)
                if state is not None:
                    state["last_digest"] = current_digest
                    if terminal_blocker:
                        state["stop_reason"] = terminal_blocker
                    else:
                        state.pop("stop_reason", None)
                    persist()
                if terminal_blocker:
                    last_snapshot["stop_reason"] = terminal_blocker
                print(json.dumps(last_snapshot, sort_keys=True))
                return 0
            if args.mode == "check":
                print(json.dumps(last_snapshot, sort_keys=True))
                return 0
            if last_snapshot["state"] != "opened":
                state["stop_reason"] = "MR is not open"
                persist()
                print(json.dumps({"run_id": args.run_id, "stop_reason": state["stop_reason"], "last_snapshot": last_snapshot}, sort_keys=True))
                return 0
            if STOP or (cancel_path.exists() and cancel_path.read_text(encoding="utf-8") == args.run_id):
                state["stop_reason"] = "cancelled"
                persist()
                print(json.dumps({"run_id": args.run_id, "stop_reason": "cancelled", "last_snapshot": last_snapshot}, sort_keys=True))
                return 0
            if time.time() >= args.deadline or spent >= args.max_requests:
                state["stop_reason"] = "deadline reached" if time.time() >= args.deadline else "request limit exhausted"
                persist()
                print(json.dumps({"run_id": args.run_id, "stop_reason": state["stop_reason"], "last_snapshot": last_snapshot}, sort_keys=True))
                return 0
            STOP_EVENT.wait(min(poll_delay, args.deadline - time.time()))
            poll_delay = min(poll_delay * 2, 60.0)
    finally:
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
