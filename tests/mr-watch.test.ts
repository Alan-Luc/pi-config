import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { it } from "bun:test";

const root = resolve(import.meta.dir, "..");
const script = join(root, "skills/mr-babysit/scripts/watch-mr.py");
const fixture = join(root, "tests/fixtures/mr-watch/fake-glab.py");
const head = "abc123";
const base = {
  "/user": { id: 42 },
  "/projects/7/merge_requests/9": { id: 1, state: "opened", sha: head, merge_status: "can_be_merged", detailed_merge_status: "mergeable", has_conflicts: false, head_pipeline: { id: 99, sha: head, status: "success" } },
  "/projects/7/pipelines/99": { id: 99, sha: head, status: "success" },
  "/projects/7/merge_requests/9/approvals": { approvals_left: 0 },
  "/projects/7/merge_requests/9/discussions": [],
};

function run(responses: Record<string, unknown>, options: { dir?: string; keepDir?: boolean; mode?: string; runId?: string; cancel?: boolean; poll?: number; maxRequests?: number; deadline?: number } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "mr-watch-test-"));
  const fake = join(dir, "glab");
  const trace = join(dir, "trace.jsonl");
  const previousCalls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").length : 0;
  const responseFile = join(dir, "responses.json");
  writeFileSync(fake, `#!/bin/sh\nexec python3 '${fixture}' "$@"\n`);
  chmodSync(fake, 0o700);
  writeFileSync(responseFile, JSON.stringify(responses));
  const deadline = options.deadline ?? Date.now() / 1000 + 30;
  const argv = [script, "--host", "gitlab.example", "--project-id", "7", "--mr-iid", "9", "--expected-user-id", "42", "--deadline", String(deadline), "--max-requests", String(options.maxRequests ?? 10)];
  if (options.mode) argv.push("--mode", options.mode);
  if (options.runId) argv.push("--run-id", options.runId);
  if (options.cancel) argv.push("--cancel");
  if (options.poll !== undefined) argv.push("--poll-interval", String(options.poll));
  const result = spawnSync("python3", argv, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "pi"), GLAB_TRACE: trace, GLAB_RESPONSES: responseFile },
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  if (!options.keepDir) rmSync(dir, { recursive: true, force: true });
  return { result, calls: calls.slice(previousCalls), dir, deadline };
}

it("emits current-head remote-ready snapshot using only pinned GET requests", () => {
  const responses = { ...base };
  const { result, calls } = run(responses);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.head_sha, head);
  assert.equal(output.remote_ready, true);
  assert.equal(output.requests_spent, 6);
  assert.deepEqual(calls.map(args => args.at(-1)), ["/user", "/projects/7/merge_requests/9", "/projects/7/pipelines/99", "/projects/7/merge_requests/9/approvals", "/projects/7/merge_requests/9/discussions?per_page=100&page=1", "/projects/7/merge_requests/9"]);
  assert(calls.every(args => args.includes("-X") && args.includes("GET") && args.includes("--hostname") && args.includes("gitlab.example")));
});

it("does not treat an older successful pipeline as the current MR pipeline", () => {
  const responses = { ...base,
    "/projects/7/merge_requests/9": { ...base["/projects/7/merge_requests/9"], head_pipeline: { id: 99, sha: head, status: "failed" } },
    "/projects/7/pipelines": [{ id: 88, sha: head, status: "success" }],
    "/projects/7/pipelines/99": { id: 99, sha: head, status: "failed" },
  };
  const { result } = run(responses);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.remote_ready, false);
  assert.equal(output.pipeline.id, 99);
  assert.equal(output.pipeline.status, "failed");
});

it("rejects a pipeline that stops succeeding in the final MR reference", () => {
  const original = base["/projects/7/merge_requests/9"];
  const responses = { ...base, sequences: {
    "/projects/7/merge_requests/9": [original, { ...original, head_pipeline: { id: 99, sha: head, status: "failed" } }],
  } };
  const { result } = run(responses);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.remote_ready, false);
  assert(output.blockers.includes("current-head pipeline missing, stale, or not successful"));
});

it("drains a large fake response instead of timing out on a full stdout pipe", () => {
  const body = "x".repeat(256 * 1024);
  const responses = { ...base, "/projects/7/merge_requests/9/discussions": [
    { id: 4, notes: [{ id: 5, body, author: { id: 42 }, resolvable: false, resolved: false }] },
  ] };
  const { result } = run(responses, { deadline: Date.now() / 1000 + 4 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).discussions[0].body.length, body.length);
});

it("invalidates a snapshot when the MR head drifts during collection", () => {
  const responses = { ...base, sequences: {
    "/projects/7/merge_requests/9": [base["/projects/7/merge_requests/9"], { ...base["/projects/7/merge_requests/9"], sha: "new-head" }],
  } };
  const { result } = run(responses);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.remote_ready, false);
  assert(output.blockers.includes("MR head changed during snapshot"));
});

it.each([
  { name: "NaN deadline", options: { deadline: Number.NaN } },
  { name: "infinite deadline", options: { deadline: Number.POSITIVE_INFINITY } },
  { name: "NaN polling interval", options: { poll: Number.NaN } },
])("rejects $name before making requests", ({ options }) => {
  const { result, calls } = run(base, options);
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 0);
});

it.each(["draft_status", "not_approved", "status_checks_must_pass", "checking"])(
  "does not report readiness when the detailed forge verdict is %s", status => {
    const mr = { ...base["/projects/7/merge_requests/9"], detailed_merge_status: status };
    const { result } = run({ ...base, "/projects/7/merge_requests/9": mr });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).remote_ready, false);
  },
);

it("stops before making a request when the request budget is exhausted", () => {
  const { result, calls } = run(base, { maxRequests: 1 });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error, "request limit exhausted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), "/user");
});

it("suppresses unchanged observations while preserving aggregate usage across rearm", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-digest-"));
  const pending = { ...base["/projects/7/merge_requests/9"], detailed_merge_status: "checking" };
  const changed = { id: 12, notes: [{ id: 13, author: { id: 77 }, body: "untrusted note", resolvable: false, resolved: false }] };
  const responses = { ...base, "/projects/7/merge_requests/9": pending, sequences: {
    "/projects/7/merge_requests/9/discussions": [[], [], [changed]],
  } };
  const initial = run(responses, { dir, keepDir: true, mode: "observe", runId: "digest-run", poll: 0.1,
    maxRequests: 30 });
  assert.equal(initial.result.status, 0, initial.result.stderr);
  assert.equal(JSON.parse(initial.result.stdout).remote_ready, false);
  const rearmed = run(responses, { dir, keepDir: true, mode: "observe", runId: "digest-run", poll: 0.1,
    maxRequests: 30, deadline: initial.deadline });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(rearmed.result.status, 0, rearmed.result.stderr);
  const output = JSON.parse(rearmed.result.stdout);
  assert.equal(output.remote_ready, false);
  assert.equal(output.requests_spent, 18);
  assert.equal(rearmed.calls.length, 12);
  assert.equal(output.discussions[0].author_id, 77);
  assert.equal(output.discussions[0].untrusted, true);
  assert.equal(output.discussions[0].body, "untrusted note");
});

it("persists ready as terminal and renews bounds only for a different run ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-renew-"));
  const initial = run(base, { dir, keepDir: true, mode: "observe", runId: "run-1", maxRequests: 10 });
  assert.equal(initial.result.status, 0, initial.result.stderr);
  assert.equal(JSON.parse(initial.result.stdout).stop_reason, "remote ready");
  const sameRun = run(base, { dir, keepDir: true, mode: "observe", runId: "run-1", maxRequests: 11, deadline: initial.deadline });
  assert.notEqual(sameRun.result.status, 0);
  const stopped = run(base, { dir, keepDir: true, mode: "observe", runId: "run-1", maxRequests: 10, deadline: initial.deadline });
  assert.equal(JSON.parse(stopped.result.stdout).stop_reason, "remote ready");
  assert.equal(stopped.calls.length, 0);
  const renewed = run(base, { dir, keepDir: true, mode: "observe", runId: "run-2", maxRequests: 10,
    deadline: Date.now() / 1000 + 30 });
  assert.equal(renewed.result.status, 0, renewed.result.stderr);
  assert.equal(JSON.parse(renewed.result.stdout).stop_reason, "remote ready");
  assert.equal(renewed.calls.length, 6);
  rmSync(dir, { recursive: true, force: true });
});

it("persists idle cancellation and performs no requests when rearmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-idle-cancel-"));
  const pending = { ...base["/projects/7/merge_requests/9"], detailed_merge_status: "checking" };
  const initial = run({ ...base, "/projects/7/merge_requests/9": pending }, {
    dir, keepDir: true, mode: "observe", runId: "idle-cancel", poll: 0.1, maxRequests: 30,
  });
  assert.equal(initial.result.status, 0, initial.result.stderr);
  assert.equal(JSON.parse(initial.result.stdout).stop_reason, undefined);
  const cancel = run(base, { dir, keepDir: true, mode: "observe", runId: "idle-cancel", cancel: true });
  assert.equal(cancel.result.status, 0, cancel.result.stderr);
  const rearmed = run(base, { dir, keepDir: true, mode: "observe", runId: "idle-cancel", poll: 0.1,
    maxRequests: 30, deadline: initial.deadline });
  assert.equal(JSON.parse(rearmed.result.stdout).stop_reason, "cancelled");
  assert.equal(rearmed.calls.length, 0);
  const runtime = join(dir, "pi", "sessions", "mr-watch");
  const stateName = readdirSync(runtime).find(name => name.endsWith(".json"));
  assert.ok(stateName);
  assert.equal(JSON.parse(readFileSync(join(runtime, stateName), "utf8")).stop_reason, "cancelled");
  rmSync(dir, { recursive: true, force: true });
});

it("cancels the owned glab process and exits cleanly on SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-cancel-"));
  const fake = join(dir, "glab");
  const trace = join(dir, "trace.jsonl");
  const responseFile = join(dir, "responses.json");
  const pidFile = join(dir, "glab.pid");
  writeFileSync(fake, `#!/bin/sh\nexec python3 '${fixture}' "$@"\n`);
  chmodSync(fake, 0o700);
  writeFileSync(responseFile, JSON.stringify(base));
  const child = spawn("python3", [script, "--mode", "observe", "--host", "gitlab.example", "--project-id", "7", "--mr-iid", "9",
    "--expected-user-id", "42", "--deadline", String(Date.now() / 1000 + 30), "--max-requests", "10", "--run-id", "cancel-test"], {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "pi"),
      GLAB_TRACE: trace, GLAB_RESPONSES: responseFile, FAKE_GLAB_DELAY: "10", FAKE_GLAB_PID: pidFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  for (let attempt = 0; attempt < 100 && !existsSync(trace); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert(existsSync(trace), "fake glab started");
  child.kill("SIGTERM");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0, stderr);
  assert.equal(JSON.parse(stdout).stop_reason, "cancelled");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  rmSync(dir, { recursive: true, force: true });
});

it.each(["checking", "unchecked", "preparing", "approvals_syncing", "ci_still_running", "ci_must_pass"])(
  "rearms pending status %s until current-head success without renewing bounds",
  status => {
    const pending = { ...base["/projects/7/merge_requests/9"], detailed_merge_status: status };
    const responses = { ...base, sequences: {
      "/projects/7/merge_requests/9": [pending, pending, base["/projects/7/merge_requests/9"], base["/projects/7/merge_requests/9"]],
    } };
    const dir = mkdtempSync(join(tmpdir(), "mr-watch-pending-"));
    const initial = run(responses, { dir, keepDir: true, mode: "observe", runId: "pending-run", poll: 0.1,
      maxRequests: 30 });
    assert.equal(initial.result.status, 0, initial.result.stderr);
    assert.equal(JSON.parse(initial.result.stdout).remote_ready, false);
    assert.equal(JSON.parse(initial.result.stdout).stop_reason, undefined);
    const replacement = run(responses, { dir, keepDir: true, mode: "observe", runId: "other-run",
      maxRequests: 30, deadline: initial.deadline });
    assert.notEqual(replacement.result.status, 0);
    assert.equal(replacement.calls.length, 0);
    const rearmed = run(responses, { dir, keepDir: true, mode: "observe", runId: "pending-run", poll: 0.1,
      maxRequests: 30, deadline: initial.deadline });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(rearmed.result.status, 0, rearmed.result.stderr);
    const output = JSON.parse(rearmed.result.stdout);
    assert.equal(output.remote_ready, true);
    assert.equal(output.head_sha, head);
    assert.equal(output.requests_spent, 12);
  },
);

it("reacquires the new head after a racing snapshot without retiring the run", () => {
  const drifted = { ...base["/projects/7/merge_requests/9"], sha: "new-head",
    head_pipeline: { id: 100, sha: "new-head", status: "success" } };
  const responses = { ...base, "/projects/7/pipelines/100": { id: 100, sha: "new-head", status: "success" }, sequences: {
    "/projects/7/merge_requests/9": [base["/projects/7/merge_requests/9"], drifted, drifted, drifted],
  } };
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-drift-"));
  const initial = run(responses, { dir, keepDir: true, mode: "observe", runId: "drift-run", poll: 0.1,
    maxRequests: 30 });
  assert.equal(initial.result.status, 0, initial.result.stderr);
  const invalidated = JSON.parse(initial.result.stdout);
  assert.equal(invalidated.remote_ready, false);
  assert.equal(invalidated.stop_reason, undefined);
  const rearmed = run(responses, { dir, keepDir: true, mode: "observe", runId: "drift-run", poll: 0.1,
    maxRequests: 30, deadline: initial.deadline });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(rearmed.result.status, 0, rearmed.result.stderr);
  const output = JSON.parse(rearmed.result.stdout);
  assert.equal(output.remote_ready, true);
  assert.equal(output.head_sha, "new-head");
  assert.equal(output.requests_spent, 12);
});

it("keeps readiness false when a later discussion page contains an unknown blocker", () => {
  const filled = Array.from({ length: 100 }, (_, i) => ({ id: i, notes: [{ id: i, resolvable: false, resolved: false }] }));
  const later = [{ id: 101, notes: [{ id: 102 }] }];
  const responses = { ...base, "/projects/7/merge_requests/9/discussions": filled };
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-page-"));
  const fake = join(dir, "glab");
  const trace = join(dir, "trace.jsonl");
  const responseFile = join(dir, "responses.json");
  writeFileSync(fake, `#!/bin/sh\nexec python3 '${fixture}' "$@"\n`);
  chmodSync(fake, 0o700);
  writeFileSync(responseFile, JSON.stringify({ ...responses, "/projects/7/merge_requests/9/discussions?per_page=100&page=2": later }));
  const result = spawnSync("python3", [script, "--host", "gitlab.example", "--project-id", "7", "--mr-iid", "9", "--expected-user-id", "42", "--deadline", String(Date.now() / 1000 + 30), "--max-requests", "10"], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "pi"), GLAB_TRACE: trace, GLAB_RESPONSES: responseFile },
  });
  const output = JSON.parse(result.stdout);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.remote_ready, false);
  assert(output.blockers.includes("discussion resolution state unknown"));
  assert(calls.some(args => args.at(-1) === "/projects/7/merge_requests/9/discussions?per_page=100&page=2"));
});
