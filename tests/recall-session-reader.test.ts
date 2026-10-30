import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "bun:test";

const root = resolve(import.meta.dir, "..");
const script = join(root, "skills/recall/scripts/read-sessions.py");
const workspace = "/tmp/recall-workspace";
const iso = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;

function session(id: string, options: { cwd?: string; parentSession?: string; entries?: object[] } = {}) {
  const header = { type: "session", version: 3, id, timestamp: iso(20), cwd: options.cwd ?? workspace, ...(options.parentSession ? { parentSession: options.parentSession } : {}) };
  return [header, ...(options.entries ?? [])].map(value => JSON.stringify(value)).join("\n") + "\n";
}

function entry(id: string, parentId: string | null, text: string, day: number, role = "user") {
  return { type: "message", id, parentId, timestamp: iso(day), message: { role, content: text, timestamp: new Date(iso(day)).getTime() } };
}

function run(args: string[], dir: string) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8", env: { ...process.env, PI_SESSION_ID: "" } });
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "recall-reader-"));
  const sessions = join(base, "workspace-sessions");
  mkdirSync(sessions);
  writeFileSync(join(sessions, "arbitrary-name.jsonl"), session("root-1", { entries: [entry("a", null, "plan decision alpha", 21), entry("b", "a", "implemented alpha", 22)] }));
  return { base, sessions };
}

it("lists only explicit workspace sessions, excluding current, marked children, and caller-excluded test IDs", () => {
  const { base, sessions } = fixture();
  try {
    writeFileSync(join(sessions, "child.jsonl"), session("child-1", { parentSession: "/parent.jsonl", entries: [{ type: "custom", id: "m", parentId: null, timestamp: iso(21), customType: "pi-subagents_launch_metadata", data: { version: 1, name: "worker", mode: "background" } }, entry("c", "m", "child result", 23)] }));
    writeFileSync(join(sessions, "test.jsonl"), session("test-1"));
    const result = run(["list", "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "root-1", "--exclude-session-id", "test-1"], base);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.sessions.map((item: { session_id: string }) => item.session_id), []);
    assert(output.omissions.some((item: { reason: string }) => item.reason === "current-session"));
    assert(output.omissions.some((item: { reason: string }) => item.reason === "known-subagent"));
    assert(output.omissions.some((item: { reason: string }) => item.reason === "caller-excluded"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it.each([undefined, "/parent.jsonl"])("excludes a valid launch marker independently of parent lineage (%s)", (parentSession) => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "marked-child.jsonl");
    writeFileSync(file, session("marked-child", { parentSession, entries: [{ type: "custom", id: "marker", parentId: null, timestamp: iso(21), customType: "pi-subagents_launch_metadata", data: { version: 1, name: "worker", mode: "background" } }, entry("child-entry", "marker", "private child result", 22)] }));
    const common = ["--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other"];
    const listed = run(["list", ...common], base);
    assert.equal(listed.status, 0, listed.stderr);
    const output = JSON.parse(listed.stdout);
    assert.equal(output.sessions.some((item: { session_id: string }) => item.session_id === "marked-child"), false);
    assert.ok(output.omissions.some((item: { session_id: string; reason: string }) => item.session_id === "marked-child" && item.reason === "known-subagent"));
    const extracted = run(["extract", ...common, "--session-file", file], base);
    assert.notEqual(extracted.status, 0);
    assert.match(extracted.stderr, /refusing known subagent session/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("extracts active leaf ancestors with original entry citations and honest activity ordering", () => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "arbitrary-name.jsonl");
    const before = readFileSync(file);
    const result = run(["extract", "--session-file", file, "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other", "--max-file-bytes", "2048"], base);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.session_id, "root-1");
    assert.equal(output.activity, "2026-10-22T12:00:00Z");
    assert.deepEqual(output.excerpts.map((item: { entry_id: string }) => item.entry_id), ["a", "b"]);
    assert(output.excerpts.every((item: { citation: string }) => item.citation.includes("root-1#")));
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("keeps ordinary fork lineage visible when subagent launch metadata is absent", () => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "fork.jsonl");
    writeFileSync(file, session("fork-1", { parentSession: "/parent.jsonl", entries: [entry("f", null, "fork decision", 22)] }));
    const result = run(["list", "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other"], base);
    assert.equal(result.status, 0, result.stderr);
    const listed = JSON.parse(result.stdout).sessions.find((item: { session_id: string }) => item.session_id === "fork-1");
    assert.equal(listed.lineage, "parent-session-recorded");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("rejects duplicate or broken entry ancestry rather than fabricating a branch", () => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "broken.jsonl");
    writeFileSync(file, session("broken-1", { entries: [entry("same", null, "first", 21), entry("same", "same", "second", 22)] }));
    const result = run(["extract", "--session-file", file, "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other"], base);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /broken or cyclic parent chain/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("follows the persisted leaf ancestry rather than including an abandoned branch", () => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "branch.jsonl");
    writeFileSync(file, session("branch-1", { entries: [entry("root", null, "shared decision", 21), entry("old", "root", "abandoned branch", 25), entry("new", "root", "current branch", 22)] }));
    const result = run(["extract", "--session-file", file, "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other", "--max-file-bytes", "4096"], base);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.extraction_branch, "last-persisted-entry-leaf");
    assert.deepEqual(output.excerpts.map((item: { entry_id: string }) => item.entry_id), ["root", "new"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("reports malformed input, workspace mismatch, and bounded-output omissions instead of silently succeeding", () => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "arbitrary-name.jsonl");
    const bounded = run(["extract", "--session-file", file, "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other", "--max-file-bytes", "20"], base);
    assert.notEqual(bounded.status, 0);
    assert.match(bounded.stderr, /byte limit/);
    const outputBounded = run(["extract", "--session-file", file, "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other", "--max-output-bytes", "20"], base);
    assert.notEqual(outputBounded.status, 0);
    assert.match(outputBounded.stderr, /output byte limit/);
    writeFileSync(join(sessions, "bad.jsonl"), "{bad json\n");
    writeFileSync(join(sessions, "other-workspace.jsonl"), session("foreign-1", { cwd: "/tmp/other-workspace" }));
    const listed = run(["list", "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other"], base);
    assert.equal(listed.status, 0, listed.stderr);
    const outputBoundedList = run(["list", "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other", "--max-output-bytes", "1"], base);
    assert.notEqual(outputBoundedList.status, 0);
    assert.match(outputBoundedList.stderr, /output byte limit/);
    const omissions = JSON.parse(listed.stdout).omissions;
    assert(omissions.some((item: { reason: string }) => item.reason === "malformed-or-missing-header"));
    assert(omissions.some((item: { reason: string }) => item.reason === "workspace-mismatch"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it.each([{ text: 42 }, { text: null }, { text: ["nested"] }, { text: undefined }])("rejects malicious non-string text blocks with a useful bounded error: $text", ({ text }) => {
  const { base, sessions } = fixture();
  try {
    const file = join(sessions, "malicious.jsonl");
    writeFileSync(file, session("malicious-text", { entries: [{ type: "message", id: "a", parentId: null, timestamp: iso(22), message: { role: "assistant", content: [{ type: "text", text }] } }] }));
    const before = readFileSync(file);
    const result = run(["extract", "--session-file", file, "--session-dir", sessions, "--workspace", workspace, "--current-session-id", "other"], base);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /text block must contain string text/);
    assert.doesNotMatch(result.stderr, /Traceback|TypeError/);
    assert.equal(result.stdout, "");
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("bounds file reads when an actual source grows after the initial size check", () => {
  const { base, sessions } = fixture();
  try {
    const driver = `import importlib.util, pathlib, sys, tracemalloc
from unittest import mock
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("recall_reader", sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
path = pathlib.Path(sys.argv[2])
original_open = pathlib.Path.open
block = b"x" * (1024 * 1024)
grew = False
def racing_open(self, mode="r", *args, **kwargs):
    global grew
    if self == path and mode == "rb" and not grew:
        with original_open(path, "ab") as writer:
            for _ in range(8): writer.write(block)
        grew = True
    return original_open(self, mode, *args, **kwargs)
tracemalloc.start()
with mock.patch.object(pathlib.Path, "open", racing_open):
    try: reader.load(path, 1024)
    except ValueError: pass
    else: raise AssertionError("a growing oversized source must reject")
_, peak = tracemalloc.get_traced_memory()
assert grew, "source growth control did not execute"
assert peak < 1024 * 1024, f"bounded 1024-byte read allocated {peak} bytes"
`;
    const result = spawnSync("python3", ["-c", driver, script, join(sessions, "arbitrary-name.jsonl")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("does not read a replaced source after the regular-file identity check", () => {
  const { base, sessions } = fixture();
  try {
    const driver = `import importlib.util, pathlib, sys
from unittest import mock
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("recall_reader", sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
path = pathlib.Path(sys.argv[2])
credential = path.with_name("credential-fixture.json")
credential.write_bytes(b"LOCAL_FIXTURE_DO_NOT_READ")
original_open = pathlib.Path.open
reads = []
class ObservedFile:
    def __init__(self, file): self.file = file
    def __enter__(self): return self
    def __exit__(self, *args): return self.file.__exit__(*args)
    def __getattr__(self, name): return getattr(self.file, name)
    def read(self, *args):
        reads.append(args)
        return self.file.read(*args)
def racing_open(self, mode="r", *args, **kwargs):
    if self == path and mode == "rb":
        path.unlink()
        path.symlink_to(credential)
        return ObservedFile(original_open(self, mode, *args, **kwargs))
    return original_open(self, mode, *args, **kwargs)
with mock.patch.object(pathlib.Path, "open", racing_open):
    try: reader.load(path, 1024)
    except ValueError: pass
    else: raise AssertionError("source replacement must reject")
assert path.is_symlink(), "source replacement control did not execute"
assert reads == [], "the replaced source contents must never be read"
`;
    const result = spawnSync("python3", ["-c", driver, script, join(sessions, "arbitrary-name.jsonl")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it("requires explicit current-session identity and does not infer it from filenames", () => {
  const { base, sessions } = fixture();
  try {
    const result = run(["list", "--session-dir", sessions, "--workspace", workspace], base);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /current-session-id/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
