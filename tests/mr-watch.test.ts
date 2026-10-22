import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(responses: Record<string, unknown>, options: { dir?: string; keepDir?: boolean; mode?: string; runId?: string; poll?: number; maxRequests?: number; deadline?: number } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "mr-watch-test-"));
  const fake = join(dir, "glab");
  const trace = join(dir, "trace.jsonl");
  const responseFile = join(dir, "responses.json");
  writeFileSync(fake, `#!/bin/sh\nexec python3 '${fixture}' "$@"\n`);
  chmodSync(fake, 0o700);
  writeFileSync(responseFile, JSON.stringify(responses));
  const deadline = options.deadline ?? Date.now() / 1000 + 30;
  const argv = [script, "--host", "gitlab.example", "--project-id", "7", "--mr-iid", "9", "--expected-user-id", "42", "--deadline", String(deadline), "--max-requests", String(options.maxRequests ?? 10)];
  if (options.mode) argv.push("--mode", options.mode);
  if (options.runId) argv.push("--run-id", options.runId);
  if (options.poll !== undefined) argv.push("--poll-interval", String(options.poll));
  const result = spawnSync("python3", argv, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "pi"), GLAB_TRACE: trace, GLAB_RESPONSES: responseFile },
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  if (!options.keepDir) rmSync(dir, { recursive: true, force: true });
  return { result, calls, dir, deadline };
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

it("persists observe bounds and emits only after unchanged state becomes meaningful", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-watch-observe-"));
  const initial = run(base, { dir, keepDir: true, mode: "observe", runId: "run-1", poll: 0.1, maxRequests: 50 });
  assert.equal(initial.result.status, 0, initial.result.stderr);
  assert.equal(JSON.parse(initial.result.stdout).remote_ready, true);
  const changed = { id: 12, notes: [{ id: 13, author: { id: 77 }, body: "untrusted note", resolvable: false, resolved: false }] };
  const responses = { ...base, sequences: {
    "/projects/7/merge_requests/9/discussions": [[], [], [changed]],
  } };
  const rearmed = run(responses, { dir, keepDir: true, mode: "observe", runId: "run-1", poll: 0.1,
    maxRequests: 50, deadline: initial.deadline });
  const output = JSON.parse(rearmed.result.stdout);
  assert.equal(rearmed.result.status, 0, rearmed.result.stderr);
  assert.equal(output.discussions[0].author_id, 77);
  assert.equal(output.discussions[0].untrusted, true);
  assert.equal(output.discussions[0].body, "untrusted note");
  assert(rearmed.calls.length >= 18);
  const wrongBounds = run(base, { dir, keepDir: false, mode: "observe", runId: "run-1", maxRequests: 51, deadline: initial.deadline });
  assert.notEqual(wrongBounds.result.status, 0);
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
    encoding: "utf8", env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GLAB_TRACE: trace, GLAB_RESPONSES: responseFile },
  });
  const output = JSON.parse(result.stdout);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.remote_ready, false);
  assert(output.blockers.includes("discussion resolution state unknown"));
  assert(calls.some(args => args.at(-1) === "/projects/7/merge_requests/9/discussions?per_page=100&page=2"));
});
