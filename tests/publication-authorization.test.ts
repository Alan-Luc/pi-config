import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { registerGuardrails } from "../extensions/guardrails/guardrails.ts";
import {
	authorizeGitPublication,
	type FrozenPublicationCandidate,
	type PublicationGrant,
	type PublicationRuntime,
	type PublicationScanRequest,
	type PublicationTarget,
} from "../extensions/guardrails/publication.ts";

const remoteUrl = "https://gitlab.example.test/group/project.git";
const instance = "https://gitlab.example.test";
const project = "group/project";
const branch = "TASK-123-fix";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "publication-gate-"));
	try {
		const repo = join(root, "repo");
		const bare = join(root, "remote.git");
		mkdirSync(repo);
		git(root, "init", "--bare", "--quiet", bare);
		git(repo, "init", "--quiet", "-b", branch);
		git(repo, "config", "user.email", "fixture@example.test");
		git(repo, "config", "user.name", "Publication Fixture");
		writeFileSync(join(repo, "file.txt"), "base\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "--quiet", "-m", "base");
		const base = git(repo, "rev-parse", "HEAD");
		git(bare, "fetch", "--quiet", repo, base);
		git(bare, "update-ref", `refs/heads/${branch}`, base);
		git(repo, "remote", "add", "origin", remoteUrl);
		git(repo, "update-ref", `refs/remotes/origin/${branch}`, base);
		writeFileSync(join(repo, "file.txt"), "task change\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "--quiet", "-m", "task change");

		const frozen = currentCandidate(repo);
		const grant: PublicationGrant = {
			enabled: true,
			instance,
			project,
			pushUrl: remoteUrl,
			branchPrefix: "TASK-",
			actions: ["push"],
			maxCommits: 4,
			scannerId: "disposable-fixture-scanner-v1",
		};
		const requests: string[] = [];
		const scans: PublicationScanRequest[] = [];
		const runtime: PublicationRuntime = {
			cwd: repo,
			loadGrant: async () => grant,
			resolveTarget: async (pushUrl, targetBranch): Promise<PublicationTarget | undefined> => {
				requests.push(`${pushUrl} ${targetBranch}`);
				if (pushUrl !== remoteUrl || targetBranch !== branch) return undefined;
				return { instance, project, protected: false, remoteHead: git(bare, "rev-parse", `refs/heads/${branch}`) };
			},
			loadFrozenCandidate: async () => frozen,
			isCandidateCurrent: async (candidate) => JSON.stringify(candidate) === JSON.stringify(currentCandidate(repo)),
			scan: async (scanRequest) => {
				scans.push(scanRequest);
				const secretFound = scanRequest.blobIds.some((blob) => git(repo, "cat-file", "blob", blob).includes("FIXTURE_SECRET_MARKER"));
				return {
					scannerId: "disposable-fixture-scanner-v1",
					candidateFingerprint: scanRequest.candidateFingerprint,
					commitIds: [...scanRequest.commitIds],
					blobIds: [...scanRequest.blobIds],
					objectSetDigest: scanRequest.objectSetDigest,
					passed: !secretFound,
				};
			},
		};

		return { root, repo, bare, base, frozen, grant, runtime, requests, scans };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function currentCandidate(repo: string): FrozenPublicationCandidate {
	const status = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
	return {
		head: git(repo, "rev-parse", "HEAD"),
		tree: git(repo, "rev-parse", "HEAD^{tree}"),
		branch: git(repo, "symbolic-ref", "--quiet", "--short", "HEAD"),
		indexTree: git(repo, "write-tree"),
		statusDigest: sha(JSON.stringify(status)),
		inputDigest: sha("fixture-frozen-inputs"),
	};
}

function refs(cwd: string): string {
	return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)");
}

async function withFixture(run: (fixture: ReturnType<typeof makeFixture>) => Promise<void>): Promise<void> {
	const fixture = makeFixture();
	try {
		await run(fixture);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}

const request = { action: "push", remote: "origin", branch, isChild: false, force: false, delete: false, mirror: false, prune: false, refspec: false, retarget: false, override: false } as const;

function registeredPushGuard(runtime: PublicationRuntime) {
	const handlers = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
	registerGuardrails({ on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) { handlers.set(name, handler); } } as never, {}, runtime);
	return (command: string) => handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "fixture-push", input: { command } } as never, { cwd: runtime.cwd } as never);
}

test("registered guard consults trusted adapters without executing a push", async () => withFixture(async (fixture) => {
	const before = { local: refs(fixture.repo), remote: refs(fixture.bare) };
	await registeredPushGuard(fixture.runtime)(`git push origin ${branch}`);
	expect(fixture.scans).toHaveLength(1);
	expect(refs(fixture.repo)).toBe(before.local);
	expect(refs(fixture.bare)).toBe(before.remote);
}));

test.each([
	`git status && git push origin ${branch}`,
	`git update-ref refs/heads/${branch} HEAD~1; git push origin ${branch}`,
	`git push origin ${branch}; git status`,
	`git -c push.default=matching push origin ${branch}`,
	`env git push origin ${branch}`,
	`env -i /usr/bin/git push origin ${branch}`,
	`MODE=fixture env -u git git push origin ${branch}`,
	`env -S 'git push origin ${branch}'`,
	`git push --force origin ${branch}`,
])("registered guard rejects companion commands and overrides: %s", async (command) => withFixture(async (fixture) => {
	const before = { local: refs(fixture.repo), remote: refs(fixture.bare) };
	await expect(registeredPushGuard(fixture.runtime)(command)).rejects.toThrow("publication");
	expect(fixture.requests).toHaveLength(0);
	expect(fixture.scans).toHaveLength(0);
	expect(refs(fixture.repo)).toBe(before.local);
	expect(refs(fixture.bare)).toBe(before.remote);
}));

test("registered guard leaves read-only env-wrapped Git outside publication authorization", async () => withFixture(async (fixture) => {
	await registeredPushGuard(fixture.runtime)("env git show push");
	expect(fixture.requests).toHaveLength(0);
	expect(fixture.scans).toHaveLength(0);
}));

test("allows only a matching fixture grant and scans exact outgoing IDs without changing refs", async () => withFixture(async (fixture) => {
	const before = { local: refs(fixture.repo), remote: refs(fixture.bare) };
	const decision = await authorizeGitPublication(request, fixture.runtime);
	expect(decision).toMatchObject({ allowed: true, commitIds: [git(fixture.repo, "rev-parse", "HEAD")] });
	if (!decision.allowed) throw new Error("expected fixture authorization");
	expect(fixture.scans[0]?.commitIds).toEqual(decision.commitIds);
	expect(fixture.scans[0]?.blobIds).toEqual(decision.blobIds);
	expect(refs(fixture.repo)).toBe(before.local);
	expect(refs(fixture.bare)).toBe(before.remote);
	// These are injected local fixture observations; no HTTP or push runs here.
	expect(fixture.requests).toEqual([`${remoteUrl} ${branch}`, `${remoteUrl} ${branch}`]);
}));

test.each([
	["no grant", (fixture: ReturnType<typeof makeFixture>) => { fixture.runtime.loadGrant = async () => undefined; }],
	["disabled grant", (fixture: ReturnType<typeof makeFixture>) => { fixture.grant.enabled = false; }],
	["outdated scanner identity", (fixture: ReturnType<typeof makeFixture>) => { fixture.grant.scannerId = "unapproved-scanner"; }],
	["invalid commit bound", (fixture: ReturnType<typeof makeFixture>) => { fixture.grant.maxCommits = 0; }],
	["no scanner", (fixture: ReturnType<typeof makeFixture>) => { fixture.runtime.scan = undefined; }],
	["GitHub target behind alias", (fixture: ReturnType<typeof makeFixture>) => {
		const aliasUrl = "git@github.com:group/project.git";
		git(fixture.repo, "remote", "set-url", "origin", aliasUrl);
		fixture.grant.pushUrl = aliasUrl;
		fixture.runtime.resolveTarget = async () => ({ instance: "https://github.com", project, protected: false, remoteHead: fixture.base });
	}],
	["protected project branch", (fixture: ReturnType<typeof makeFixture>) => { fixture.runtime.resolveTarget = async () => ({ instance, project, protected: true, remoteHead: fixture.base }); }],
	["wrong project", (fixture: ReturnType<typeof makeFixture>) => { fixture.runtime.resolveTarget = async () => ({ instance, project: "other/project", protected: false, remoteHead: fixture.base }); }],
	["multiple push URLs", (fixture: ReturnType<typeof makeFixture>) => { git(fixture.repo, "remote", "set-url", "--add", "--push", "origin", "https://github.com/group/project.git"); }],
] as const)("denies %s", async (_name, setup) => withFixture(async (fixture) => {
	setup(fixture);
	const decision = await authorizeGitPublication(request, fixture.runtime);
	expect(decision).toMatchObject({ allowed: false });
}));

test("denies dirty source and changed frozen refs", async () => withFixture(async (fixture) => {
	writeFileSync(join(fixture.repo, "uncommitted.txt"), "drift\n");
	expect(await authorizeGitPublication(request, fixture.runtime)).toMatchObject({ allowed: false, reason: expect.stringContaining("uncommitted") });
	rmSync(join(fixture.repo, "uncommitted.txt"));
	git(fixture.repo, "update-ref", `refs/heads/${branch}`, fixture.base);
	expect(await authorizeGitPublication(request, fixture.runtime)).toMatchObject({ allowed: false });
}));

test("denies a remote ref advanced after the frozen candidate", async () => withFixture(async (fixture) => {
	const head = git(fixture.repo, "rev-parse", "HEAD");
	git(fixture.bare, "fetch", "--quiet", fixture.repo, head);
	git(fixture.bare, "update-ref", `refs/heads/${branch}`, head);
	expect(await authorizeGitPublication(request, fixture.runtime)).toMatchObject({ allowed: false, reason: expect.stringContaining("commit count") });
}));

test("includes secret-bearing intermediate commits and blobs despite a clean net diff", async () => withFixture(async (fixture) => {
	const outgoingBase = git(fixture.repo, "rev-parse", "HEAD");
	git(fixture.bare, "fetch", "--quiet", fixture.repo, outgoingBase);
	git(fixture.bare, "update-ref", `refs/heads/${branch}`, outgoingBase);
	git(fixture.repo, "update-ref", `refs/remotes/origin/${branch}`, outgoingBase);
	writeFileSync(join(fixture.repo, "intermediate.txt"), "FIXTURE_SECRET_MARKER\n");
	git(fixture.repo, "add", "intermediate.txt");
	git(fixture.repo, "commit", "--quiet", "-m", "intermediate secret");
	const intermediate = git(fixture.repo, "rev-parse", "HEAD");
	git(fixture.repo, "rm", "--quiet", "intermediate.txt");
	git(fixture.repo, "commit", "--quiet", "-m", "remove intermediate secret");
	const head = git(fixture.repo, "rev-parse", "HEAD");
	expect(git(fixture.repo, "diff", `${outgoingBase}..${head}`)).toBe("");
	fixture.runtime.loadFrozenCandidate = async () => currentCandidate(fixture.repo);
	fixture.runtime.isCandidateCurrent = async (candidate) => JSON.stringify(candidate) === JSON.stringify(currentCandidate(fixture.repo));
	const decision = await authorizeGitPublication(request, fixture.runtime);
	expect(fixture.scans[0]?.commitIds).toContain(intermediate);
	expect(fixture.scans[0]?.blobIds.some((blob) => git(fixture.repo, "cat-file", "blob", blob).includes("FIXTURE_SECRET_MARKER"))).toBe(true);
	expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining("scanner") });
	expect(JSON.stringify(decision)).not.toContain("FIXTURE_SECRET_MARKER");
}));

test("denies source-input drift reported by the parent candidate owner", async () => withFixture(async (fixture) => {
	fixture.runtime.isCandidateCurrent = async () => false;
	expect(await authorizeGitPublication(request, fixture.runtime)).toMatchObject({ allowed: false, reason: expect.stringContaining("source or verification inputs") });
}));

test("rechecks remote refs after scanner evaluation", async () => withFixture(async (fixture) => {
	fixture.runtime.scan = async (scanRequest) => {
		const head = git(fixture.repo, "rev-parse", "HEAD");
		git(fixture.bare, "fetch", "--quiet", fixture.repo, head);
		git(fixture.bare, "update-ref", `refs/heads/${branch}`, head);
		return {
			scannerId: fixture.grant.scannerId,
			candidateFingerprint: scanRequest.candidateFingerprint,
			commitIds: [...scanRequest.commitIds],
			blobIds: [...scanRequest.blobIds],
			objectSetDigest: scanRequest.objectSetDigest,
			passed: true,
		};
	};
	expect(await authorizeGitPublication(request, fixture.runtime)).toMatchObject({ allowed: false, reason: expect.stringContaining("changed during authorization") });
}));

test("denies scanner attestations for incomplete or altered object sets", async () => withFixture(async (fixture) => {
	fixture.runtime.scan = async (scanRequest) => ({
		scannerId: "disposable-fixture-scanner-v1",
		candidateFingerprint: scanRequest.candidateFingerprint,
		commitIds: [],
		blobIds: [...scanRequest.blobIds],
		objectSetDigest: scanRequest.objectSetDigest,
		passed: true,
	});
	expect(await authorizeGitPublication(request, fixture.runtime)).toMatchObject({ allowed: false, reason: expect.stringContaining("exact outgoing") });
}));

test.each(["force", "delete", "mirror", "prune", "refspec", "retarget", "override"] as const)("denies %s shapes before consulting adapters", async (shape) => withFixture(async (fixture) => {
	const malicious = { ...request, [shape]: true };
	expect(await authorizeGitPublication(malicious, fixture.runtime)).toMatchObject({ allowed: false });
	expect(fixture.requests).toHaveLength(0);
}));

test("denies child callers before consulting adapters", async () => withFixture(async (fixture) => {
	expect(await authorizeGitPublication({ ...request, isChild: true }, fixture.runtime)).toMatchObject({ allowed: false });
	expect(fixture.requests).toHaveLength(0);
}));
