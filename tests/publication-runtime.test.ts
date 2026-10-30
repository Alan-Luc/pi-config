import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { PUBLICATION_CLEARANCE_REQUEST, PUBLICATION_CLEARANCE_RESPONSE } from "../extensions/artifact-contracts/publication-clearance.ts";
import { createGitLabTargetResolver, createPublicationRuntime, createScannerAdapter, parsePublicationConfig, pushUrlMatchesProject, type ScannerIdentity } from "../extensions/guardrails/publication-runtime.ts";
import type { EventBus } from "@earendil-works/pi-coding-agent";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("push URL must identify the granted GitLab project", () => {
	expect(pushUrlMatchesProject("https://gitlab.fixture/group/project.git", "https://gitlab.fixture", "group/project")).toBe(true);
	expect(pushUrlMatchesProject("git@gitlab.fixture:group/project.git", "https://gitlab.fixture", "group/project")).toBe(true);
	expect(pushUrlMatchesProject("https://gitlab.fixture/other/project.git", "https://gitlab.fixture", "group/project")).toBe(false);
	expect(pushUrlMatchesProject("https://gitlab.fixture/group/project.git?token=secret", "https://gitlab.fixture", "group/project")).toBe(false);
});

test("disabled example and schema are valid JSON and cannot enable publication", () => {
	const example = JSON.parse(readFileSync(new URL("../extensions/guardrails/publication-grant.example.json", import.meta.url), "utf8")) as unknown;
	JSON.parse(readFileSync(new URL("../extensions/guardrails/publication-grant.schema.json", import.meta.url), "utf8")) as unknown;
	expect(example).toMatchObject({ enabled: false });
	expect(parsePublicationConfig(example)).toBeUndefined();
});

test("disabled and malformed grant configs never produce a grant", () => {
	expect(parsePublicationConfig({ enabled: false })).toBeUndefined();
	expect(parsePublicationConfig({ enabled: true, unexpected: true })).toBeUndefined();
});

test("grant config accepts only the literal alan ENG prefix", () => {
	const config = { enabled: true, instance: "https://gitlab.fixture", project: "group/project", pushUrl: "https://gitlab.fixture/group/project.git", branchPrefix: "alan/ENG-", actions: ["push"], maxCommits: 1, gitlabTokenEnv: "FIXTURE_TOKEN",
		scanner: { executable: "/fixture/scanner", version: "fixture-1", configPath: "/fixture/config", configSha256: "a".repeat(64), scannerId: "b".repeat(64) } };
	expect(parsePublicationConfig(config)?.branchPrefix).toBe("alan/ENG-");
	for (const branchPrefix of ["TASK-", "alan/", "alan/ENG-fixture"]) expect(parsePublicationConfig({ ...config, branchPrefix })).toBeUndefined();
});

test("GitLab target adapter confirms project identity, complete refs, and branch state", async () => {
	const config = { enabled: true, instance: "https://gitlab.fixture", project: "group/project", pushUrl: "https://gitlab.fixture/group/project.git", gitlabTokenEnv: "FIXTURE_TOKEN" };
	const advertisedRefs = [{ ref: "refs/heads/alan/ENG-fixture", sha: "b".repeat(40) }, { ref: "refs/heads/main", sha: "a".repeat(40) }];
	const responses = [
		new Response(JSON.stringify({ id: 17, path_with_namespace: "group/project", web_url: "https://gitlab.fixture/group/project" }), { status: 200 }),
		new Response(JSON.stringify({ protected: false, commit: { id: "b".repeat(40) } }), { status: 200 }),
	];
	const resolver = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async () => responses.shift()!, async () => advertisedRefs);
	expect(await resolver(config.pushUrl, "alan/ENG-fixture")).toMatchObject({ instance: config.instance, project: config.project, protected: false, branchState: { state: "existing", head: "b".repeat(40) }, advertisedRefs });
});

test("advertised refs use the publication owner's locale-independent ordering", async () => {
	const root = mkdtempSync(join(tmpdir(), "publication-advertisement-order-"));
	const previousPath = process.env.PATH;
	try {
		const fakeGit = join(root, "git");
		writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\t%s\\n' '${"a".repeat(40)}' refs/heads/ENG-existing '${"b".repeat(40)}' refs/heads/alan/ENG-fixture '${"c".repeat(40)}' refs/heads/main\n`);
		chmodSync(fakeGit, 0o700);
		process.env.PATH = `${root}:${previousPath}`;
		const config = { instance: "https://gitlab.fixture", project: "group/project", pushUrl: "https://gitlab.fixture/group/project.git", gitlabTokenEnv: "FIXTURE_TOKEN" };
		const responses = [new Response(JSON.stringify({ id: 17, path_with_namespace: "group/project", web_url: "https://gitlab.fixture/group/project" })), new Response(JSON.stringify({ protected: false, commit: { id: "b".repeat(40) } }))];
		const resolver = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async () => responses.shift()!);
		const target = await resolver(config.pushUrl, "alan/ENG-fixture");
		expect(target?.advertisedRefs.map(({ ref }) => ref)).toEqual(["refs/heads/ENG-existing", "refs/heads/alan/ENG-fixture", "refs/heads/main"]);
	} finally { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); }
});

test("an absent branch must still confirm matching wildcard protection", async () => {
	const config = { instance: "https://gitlab.fixture", project: "group/project", pushUrl: "https://gitlab.fixture/group/project.git", gitlabTokenEnv: "FIXTURE_TOKEN" };
	const resolver = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async (url) => {
		if (String(url).includes("/repository/branches/")) return new Response("missing", { status: 404 });
		if (String(url).includes("/protected_branches")) return new Response(JSON.stringify([{ name: "alan/ENG-*" }]));
		return new Response(JSON.stringify({ id: 17, path_with_namespace: "group/project", web_url: "https://gitlab.fixture/group/project" }));
	}, async () => []);
	expect(await resolver(config.pushUrl, "alan/ENG-fixture")).toMatchObject({ protected: true, branchState: { state: "absent" } });
});

test("GitLab target adapter denies ambiguous absence and mismatched project", async () => {
	const config = { instance: "https://gitlab.fixture", project: "group/project", pushUrl: "https://gitlab.fixture/group/project.git", gitlabTokenEnv: "FIXTURE_TOKEN" };
	const project = { id: 17, path_with_namespace: "group/project", web_url: "https://gitlab.fixture/group/project" };
	const absentButAdvertised = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async () => new Response(JSON.stringify(project), { status: 200 }), async () => [{ ref: "refs/heads/alan/ENG-fixture", sha: "a".repeat(40) }]);
	expect(await absentButAdvertised(config.pushUrl, "alan/ENG-fixture")).toBeUndefined();
	const wrongProject = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async () => new Response(JSON.stringify({ ...project, path_with_namespace: "other/project", web_url: "https://gitlab.fixture/other/project" }), { status: 200 }), async () => []);
	expect(await wrongProject(config.pushUrl, "alan/ENG-fixture")).toBeUndefined();
	const fetchBranchMissing = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async (url) => String(url).endsWith("/repository/branches/alan%2FENG-fixture") ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(String(url).includes('/protected_branches') ? [] : project), { status: 200 }), async () => [{ ref: "refs/heads/main", sha: "a".repeat(40) }]);
	expect(await fetchBranchMissing(config.pushUrl, "alan/ENG-fixture")).toMatchObject({ branchState: { state: "absent" } });
});

test.each(["unavailable", "malformed", "next-page", "full-page"] as const)("absent branch protection %s remains unknown", async (scenario) => {
	const config = { instance: "https://gitlab.fixture", project: "group/project", pushUrl: "https://gitlab.fixture/group/project.git", gitlabTokenEnv: "FIXTURE_TOKEN" };
	const resolver = createGitLabTargetResolver(config, { FIXTURE_TOKEN: "fixture-only" }, async (url) => {
		if (String(url).includes("/repository/branches/")) return new Response("missing", { status: 404 });
		if (String(url).includes("/protected_branches")) return new Response(JSON.stringify(scenario === "full-page" ? Array.from({ length: 100 }, () => ({ name: "release-*" })) : scenario === "malformed" ? [{ name: null }] : []),
			{ status: scenario === "unavailable" ? 403 : 200, headers: scenario === "next-page" ? { "x-next-page": "2" } : {} });
		return new Response(JSON.stringify({ id: 17, path_with_namespace: "group/project", web_url: "https://gitlab.fixture/group/project" }));
	}, async () => []);
	expect(await resolver(config.pushUrl, "alan/ENG-fixture")).toBeUndefined();
});

test.each(["valid", "absent", "duplicate", "malformed"] as const)("clearance query handles %s responses fail-closed", async (mode) => {
	const responses: Array<(value: unknown) => void> = [];
	const requests: unknown[] = [];
	const events = {
		on(channel: string, callback: (value: unknown) => void) {
			if (channel === PUBLICATION_CLEARANCE_RESPONSE) responses.push(callback);
			return () => { responses.splice(responses.indexOf(callback), 1); };
		},
		emit(channel: string, value: unknown) {
			if (channel !== PUBLICATION_CLEARANCE_REQUEST) return;
			requests.push(value);
			if (mode === "absent") return;
			const request = value as { version: 1; requestId: string; cwd: string };
			const response = { ...request, loadFrozenCandidate: async () => undefined, isCandidateCurrent: async () => true };
			for (const reply of [...responses]) reply(mode === "malformed" ? { ...response, extra: true } : response);
			if (mode === "duplicate") for (const reply of [...responses]) reply(response);
		},
	} as unknown as EventBus;
	const runtime = createPublicationRuntime({ events, cwd: "/owned/repo", grant: { enabled: true, instance: "https://gitlab.invalid", project: "group/project", pushUrl: "https://gitlab.invalid/group/project.git", branchPrefix: "alan/ENG-", actions: ["push"], maxCommits: 1, scannerId: "fixture" }, resolveTarget: async () => undefined, scan: async () => { throw new Error("not reached"); } });
	expect(await runtime.loadFrozenCandidate()).toBeUndefined();
	expect(await runtime.isCandidateCurrent({ head: "a", tree: "b", branch: "alan/ENG-fixture", indexTree: "c", statusDigest: "d", inputDigest: "e" })).toBe(mode === "valid");
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ version: 1, cwd: "/owned/repo" });
});

test("scanner adapter scans exact object bytes and rejects findings", async () => {
	const root = mkdtempSync(join(tmpdir(), "publication-scanner-fixture-"));
	try {
		const repo = join(root, "repo");
		const executable = join(root, "scanner");
		const configPath = join(root, "scanner-config");
		mkdirSync(repo);
		execFileSync("git", ["init", "--quiet", repo]);
		const fixtureProgram = "#!/usr/bin/env node\nlet input='';if(process.argv[2]==='--version'){console.log('fixture-1')}else{process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const i=process.argv.indexOf('--report-path');if(i>=0&&process.argv[i+1]==='-')console.log(input.includes('FIXTURE_SECRET_MARKER')?'[{}]':'[]')})}\n";
		writeFileSync(executable, fixtureProgram);
		chmodSync(executable, 0o700);
		writeFileSync(configPath, "fixture config\n");
		const cleanBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "clean text\n", encoding: "utf8" }).trim();
		const secretBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "FIXTURE_SECRET_MARKER\n", encoding: "utf8" }).trim();
		const configSha256 = hash("fixture config\n");
		const identity: ScannerIdentity = {
			cwd: repo, executable, version: "fixture-1", configPath, configSha256,
			scannerId: hash(`${hash(fixtureProgram)}\nfixture-1\n${configSha256}`),
		};
		const scan = await createScannerAdapter(identity);
		const request = { candidateFingerprint: hash("candidate"), commitIds: ["commit-fixture"], blobIds: [cleanBlob, secretBlob], objectSetDigest: hash("objects") };
		await expect(scan({ ...request, blobIds: [cleanBlob] })).resolves.toMatchObject({ passed: true, blobIds: [cleanBlob] });
		const result = await scan(request);
		expect(result).toMatchObject({ scannerId: identity.scannerId, passed: false, blobIds: request.blobIds });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanner adapter rejects changed configuration identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "publication-scanner-invalid-"));
	try {
		const executable = join(root, "scanner");
		const configPath = join(root, "config");
		writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fixture-1; else echo incomplete; fi\n");
		chmodSync(executable, 0o700);
		writeFileSync(configPath, "config\n");
		const configSha256 = hash("config\n");
		const identity: ScannerIdentity = { cwd: root, executable, version: "fixture-1", configPath, configSha256, scannerId: hash(`${hash(await Bun.file(executable).bytes())}\nfixture-1\n${configSha256}`) };
		writeFileSync(configPath, "changed\n");
		await expect(createScannerAdapter(identity)).rejects.toThrow("configuration identity mismatch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
