import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";
import type { CandidateExec } from "../extensions/artifact-contracts/verification.ts";
import { createStagedSnapshot } from "../extensions/artifact-contracts/staged-verification.ts";
import { createHash } from "node:crypto";
import { createCandidateIdentity, recordVerificationEvidence } from "../extensions/artifact-contracts/verification-store.ts";
import { publicationEvidenceErrors } from "../extensions/artifact-contracts/publication-clearance.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function run(argv: string[], cwd: string | undefined) {
  const child = Bun.spawn(argv, { cwd: cwd ?? process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}
async function git(cwd: string, ...args: string[]) { const result = await run(["git", ...args], cwd); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); }
const exec: CandidateExec = async (file, args, options) => {
  const result = await run([file, ...args], options.cwd);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, killed: false };
};
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "staged-snapshot-test-"))); roots.push(root);
  await git(root, "init", "--quiet"); await git(root, "config", "user.email", "test@example.test"); await git(root, "config", "user.name", "test");
  writeFileSync(join(root, "source.txt"), "base\n"); await git(root, "add", "source.txt"); await git(root, "commit", "--quiet", "-m", "base");
  return root;
}

test("snapshot executes frozen index tree and validates/cleans its owned directory", async () => {
  const root = await fixture();
  writeFileSync(join(root, "source.txt"), "staged broken\n"); await git(root, "add", "source.txt");
  writeFileSync(join(root, "source.txt"), "unstaged repair\n");
  const beforeIndex = readFileSync(join(root, ".git", "index"));
  const snapshot = await createStagedSnapshot(exec, root);
  assert.equal(readFileSync(join(snapshot.directory, "source.txt"), "utf8"), "staged broken\n");
  assert.notEqual(snapshot.tree, await git(root, "rev-parse", "HEAD^{tree}"));
  const nodeCheck = ["-e", "process.exit(require('node:fs').readFileSync('source.txt', 'utf8') === process.argv[1] ? 0 : 1)", "unstaged repair\n"];
  assert.equal((await exec("node", nodeCheck, { cwd: root })).code, 0, "the identical check sees the working-tree repair");
  assert.equal((await exec("node", nodeCheck, { cwd: snapshot.cwd })).code, 1, "the physical snapshot must expose staged content");
  await snapshot.validate();
  assert.deepEqual(readFileSync(join(root, ".git", "index")), beforeIndex, "snapshot creation must not rewrite the real index");
  await git(root, "add", "source.txt");
  const green = await createStagedSnapshot(exec, root);
  assert.equal((await exec("node", nodeCheck, { cwd: green.cwd })).code, 0, "the staged green candidate passes the same real Node check");
  await green.validate(); green.cleanup();
  snapshot.cleanup(); snapshot.cleanup();
  assert.throws(() => readFileSync(snapshot.directory));
});

test("runtime inputs must be ignored and pin file and directory contents", async () => {
  const root = await fixture();
  writeFileSync(join(root, ".gitignore"), "/deps.json\n/vendor/\n/missing.json\n");
  await git(root, "add", ".gitignore"); await git(root, "commit", "--quiet", "-m", "ignore runtime inputs");
  writeFileSync(join(root, "deps.json"), "one\n");
  mkdirSync(join(root, "vendor")); writeFileSync(join(root, "vendor", "library.js"), "one\n");
  writeFileSync(join(root, "ordinary.json"), "unignored\n");
  await assert.rejects(createStagedSnapshot(exec, root, ".", ["ordinary.json"]), /must be ignored/);

  const snapshot = await createStagedSnapshot(exec, root, ".", ["deps.json", "vendor"]);
  assert.equal(readFileSync(join(snapshot.directory, "deps.json"), "utf8"), "one\n");
  assert.equal(readFileSync(join(snapshot.directory, "vendor", "library.js"), "utf8"), "one\n");
  writeFileSync(join(root, "deps.json"), "two\n");
  await assert.rejects(snapshot.validate(), /runtime input changed/);
  snapshot.cleanup();

  writeFileSync(join(root, "deps.json"), "one\n");
  const added = await createStagedSnapshot(exec, root, ".", ["deps.json", "vendor"]);
  writeFileSync(join(root, "vendor", "added.js"), "added\n");
  await assert.rejects(added.validate(), /runtime input changed/); added.cleanup();

  unlinkSync(join(root, "vendor", "added.js"));
  const removed = await createStagedSnapshot(exec, root, ".", ["deps.json", "vendor"]);
  unlinkSync(join(root, "vendor", "library.js"));
  await assert.rejects(removed.validate(), /runtime input changed/); removed.cleanup();

  await assert.rejects(createStagedSnapshot(exec, root, ".", ["missing.json"]), /missing or unreadable/);
  await assert.rejects(createStagedSnapshot(exec, root, ".", ["source.txt"]), /overlaps staged tracked source/);
  await assert.rejects(createStagedSnapshot(exec, root, ".", ["../outside"]), /repository-relative/);
  unlinkSync(join(root, "source.txt")); await git(root, "add", "-u");
  writeFileSync(join(root, "source.txt"), "must not overlay staged deletion\n");
  await assert.rejects(createStagedSnapshot(exec, root, ".", ["source.txt"]), /overlaps staged tracked source/);
});

test.each(["file", "directory", "mode"])("publication pins retain canonical %s manifest semantics", async (change) => {
  const root = await fixture();
  writeFileSync(join(root, ".gitignore"), "/deps.json\n/vendor/\n/proof.log\n");
  await git(root, "add", ".gitignore"); await git(root, "commit", "--quiet", "-m", "ignore runtime inputs");
  writeFileSync(join(root, "deps.json"), "dependency\n");
  mkdirSync(join(root, "vendor")); writeFileSync(join(root, "vendor", "module.js"), "module\n");
  const snapshot = await createStagedSnapshot(exec, root, ".", ["deps.json", "vendor"]);
  try {
    const candidate = createCandidateIdentity({ repositoryRoot: root, head: snapshot.head, tree: snapshot.tree, kind: "clean", source: "staged", runtimeInputs: snapshot.runtimeInputs });
    const logPath = join(root, "proof.log"); writeFileSync(logPath, "verified\n");
    const proof = recordVerificationEvidence({ command: "'fixture-check'", argv: ["fixture-check"], cwd: ".", candidate, exitCode: 0, logPath,
      logSha256: createHash("sha256").update("verified\n").digest("hex"), valid: true });
    assert.deepEqual(publicationEvidenceErrors([proof.id], candidate), [], "unchanged canonical pins must validate, including directory manifests");
    if (change === "file") writeFileSync(join(root, "deps.json"), "changed\n");
    else if (change === "directory") writeFileSync(join(root, "vendor", "extra.js"), "extra\n");
    else chmodSync(join(root, "vendor", "module.js"), 0o755);
    assert.match(publicationEvidenceErrors([proof.id], candidate).join("; "), /runtime input|input pin/, "publication must reject changed content, directory members, or modes");
  } finally { snapshot.cleanup(); }
});

test("runtime input replacement by an identical-byte external symlink is rejected", async () => {
  const root = await fixture();
  writeFileSync(join(root, ".gitignore"), "/deps.json\n");
  await git(root, "add", ".gitignore"); await git(root, "commit", "--quiet", "-m", "ignore runtime input");
  writeFileSync(join(root, "deps.json"), "identical bytes\n");
  const external = realpathSync(mkdtempSync(join(tmpdir(), "staged-runtime-external-"))); roots.push(external);
  const target = join(external, "deps.json"); writeFileSync(target, "identical bytes\n");
  const snapshot = await createStagedSnapshot(exec, root, ".", ["deps.json"]);
  unlinkSync(join(root, "deps.json")); symlinkSync(target, join(root, "deps.json"));
  await assert.rejects(snapshot.validate(), /symbolic link|escapes repository/);
  snapshot.cleanup();
});

test("newline tracked and staged-deleted paths cannot be overlaid as runtime inputs", async () => {
  const root = await fixture();
  const path = "source\nquoted.txt";
  writeFileSync(join(root, path), "staged content\n"); await git(root, "add", "--", path);
  writeFileSync(join(root, path), "working repair\n");
  await assert.rejects(createStagedSnapshot(exec, root, ".", [path]), /overlaps staged tracked source/);

  await git(root, "commit", "--quiet", "-m", "add newline path");
  unlinkSync(join(root, path)); await git(root, "add", "-u", "--", path);
  writeFileSync(join(root, path), "overlay after deletion\n");
  await assert.rejects(createStagedSnapshot(exec, root, ".", [path]), /overlaps staged tracked source/);
});

test("runtime copies preserve modes and clean readonly dependency directories", async () => {
  const root = await fixture();
  writeFileSync(join(root, ".gitignore"), "/vendor/\n");
  await git(root, "add", ".gitignore"); await git(root, "commit", "--quiet", "-m", "ignore dependencies");
  mkdirSync(join(root, "vendor", "readonly"), { recursive: true });
  writeFileSync(join(root, "vendor", "library.js"), "module.exports = true;\n");
  writeFileSync(join(root, "vendor", "readonly", "library.js"), "module.exports = true;\n");
  chmodSync(join(root, "vendor", "library.js"), 0o777);
  chmodSync(join(root, "vendor", "readonly"), 0o555);
  const previousMask = process.umask(0o022);
  let snapshot: Awaited<ReturnType<typeof createStagedSnapshot>> | undefined;
  try {
    snapshot = await createStagedSnapshot(exec, root, ".", ["vendor"]);
    assert.equal(statSync(join(snapshot.directory, "vendor", "library.js")).mode & 0o777, 0o777);
    assert.equal(statSync(join(snapshot.directory, "vendor", "readonly")).mode & 0o777, 0o555);
    await snapshot.validate();
  } finally {
    process.umask(previousMask);
    chmodSync(join(root, "vendor", "readonly"), 0o755);
    snapshot?.cleanup();
  }
});

test("snapshot source permission changes invalidate the frozen image", async () => {
  const root = await fixture();
  const snapshot = await createStagedSnapshot(exec, root);
  try {
    chmodSync(join(snapshot.directory, "source.txt"), 0o755);
    await assert.rejects(snapshot.validate(), /source image changed/);
  } finally {
    snapshot.cleanup();
  }
});

test("skip-worktree staged files are materialized", async () => {
  const root = await fixture();
  writeFileSync(join(root, "source.txt"), "staged broken\n"); await git(root, "add", "source.txt");
  await git(root, "update-index", "--skip-worktree", "source.txt");
  const index = readFileSync(join(root, ".git", "index"));
  const snapshot = await createStagedSnapshot(exec, root);
  try {
    assert.equal(readFileSync(join(snapshot.directory, "source.txt"), "utf8"), "staged broken\n");
    await snapshot.validate();
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "materialization must preserve real index flags");
  } finally {
    snapshot.cleanup();
  }
});

test("node --test discovers a skip-worktree staged test", async () => {
  const root = await fixture();
  writeFileSync(join(root, "broken.test.js"), "const test=require('node:test');const assert=require('node:assert/strict');test('staged assertion',()=>assert.equal('broken','fixed'));\n");
  await git(root, "add", "broken.test.js");
  await git(root, "update-index", "--skip-worktree", "broken.test.js");
  const index = readFileSync(join(root, ".git", "index"));
  const snapshot = await createStagedSnapshot(exec, root);
  try {
    const result = await run(["node", "--test"], snapshot.cwd);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /staged assertion/);
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "node --test must not change real index flags");
  } finally {
    snapshot.cleanup();
  }
});

test("stat-only index refresh with unchanged tree remains valid", async () => {
  const root = await fixture();
  const snapshot = await createStagedSnapshot(exec, root);
  try {
    const future = new Date(Date.now() + 2_000);
    utimesSync(join(root, "source.txt"), future, future);
    await git(root, "status", "--short");
    await assert.doesNotReject(snapshot.validate(), "stat-only index changes with unchanged tree are valid");
  } finally {
    snapshot.cleanup();
  }
});

test("stale index, HEAD, and modified snapshot source invalidate validation", async () => {
  const root = await fixture(); const snapshot = await createStagedSnapshot(exec, root);
  writeFileSync(join(root, "source.txt"), "next\n"); await git(root, "add", "source.txt");
  await assert.rejects(snapshot.validate(), /tree changed/); snapshot.cleanup();
  const next = await createStagedSnapshot(exec, root);
  writeFileSync(join(next.directory, "source.txt"), "tampered\n");
  await assert.rejects(next.validate(), /source image changed/); next.cleanup();
  const last = await createStagedSnapshot(exec, root);
  await git(root, "commit", "--quiet", "-m", "move head");
  await assert.rejects(last.validate(), /HEAD changed/); last.cleanup();
});
