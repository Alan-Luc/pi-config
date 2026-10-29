import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { PUBLICATION_CLEARANCE_REQUEST, PUBLICATION_CLEARANCE_RESPONSE, type PublicationClearanceRequest, type PublicationClearanceResponse } from "../artifact-contracts/publication-clearance.ts";
import type { FrozenPublicationCandidate, PublicationGrant, PublicationRuntime, PublicationScanRequest, PublicationScanResult, PublicationTarget } from "./publication.ts";

export type ScannerConfig = {
	executable: string;
	version: string;
	configPath: string;
	configSha256: string;
	scannerId: string;
};

export type PublicationRuntimeConfig = {
	enabled: boolean;
	instance: string;
	project: string;
	pushUrl: string;
	branchPrefix: "alan/ENG-";
	actions: readonly string[];
	maxCommits: number;
	gitlabTokenEnv: string;
	scanner: ScannerConfig;
};

export type ScannerIdentity = ScannerConfig & { cwd: string };

export type PublicationRuntimeDependencies = {
	events: EventBus;
	cwd: string;
	config?: unknown;
	env?: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
	grant?: PublicationGrant;
	resolveTarget?: (pushUrl: string, branch: string) => Promise<PublicationTarget | undefined>;
	scan?: (request: PublicationScanRequest) => Promise<PublicationScanResult>;
};

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function queryClearance(events: EventBus, cwd: string): PublicationClearanceResponse | undefined {
	const request: PublicationClearanceRequest = { version: 1, requestId: randomUUID(), cwd };
	const responses: unknown[] = [];
	const unsubscribe = events.on(PUBLICATION_CLEARANCE_RESPONSE, (value) => { responses.push(value); });
	try {
		events.emit(PUBLICATION_CLEARANCE_REQUEST, request);
	} finally {
		unsubscribe();
	}
	if (responses.length !== 1) return undefined;
	const response = responses[0];
	if (!record(response) || Object.keys(response).sort().join(",") !== "cwd,isCandidateCurrent,loadFrozenCandidate,requestId,version"
		|| response.version !== 1 || response.requestId !== request.requestId || response.cwd !== cwd
		|| typeof response.loadFrozenCandidate !== "function" || typeof response.isCandidateCurrent !== "function") return undefined;
	return {
		version: 1, requestId: request.requestId, cwd,
		loadFrozenCandidate: response.loadFrozenCandidate as PublicationClearanceResponse["loadFrozenCandidate"],
		isCandidateCurrent: response.isCandidateCurrent as PublicationClearanceResponse["isCandidateCurrent"],
	};
}

export async function createScannerAdapter(identity: ScannerIdentity): Promise<(request: PublicationScanRequest) => Promise<PublicationScanResult>> {
	const executable = resolve(identity.executable);
	const configPath = resolve(identity.configPath);
	const [binary, config] = await Promise.all([readFile(executable), readFile(configPath)]);
	if (sha256(config) !== identity.configSha256) throw new Error("scanner configuration identity mismatch");
	const version = await execute(executable, ["--version"]);
	if (version.trim() !== identity.version) throw new Error("scanner version identity mismatch");
	const scannerId = sha256(`${sha256(binary)}\n${version.trim()}\n${identity.configSha256}`);
	if (scannerId !== identity.scannerId) throw new Error("scanner executable identity mismatch");
	return async (request) => {
		let passed = true;
		for (const blobId of request.blobIds) {
			const [currentBinary, currentConfig, currentVersion] = await Promise.all([
				readFile(executable), readFile(configPath), execute(executable, ["--version"]),
			]);
			if (sha256(currentBinary) !== sha256(binary) || sha256(currentConfig) !== identity.configSha256 || currentVersion.trim() !== identity.version) throw new Error("scanner identity changed during scan");
			const content = await execute(executable, ["stdin", "--no-banner", "--config", configPath, "--report-format", "json", "--report-path", "-"], await readBlob(identity.cwd, blobId));
			let findings: unknown;
			try { findings = JSON.parse(content); } catch { throw new Error("scanner returned malformed output"); }
			if (!Array.isArray(findings)) throw new Error("scanner returned incomplete output");
			if (findings.length) passed = false;
		}
		return { scannerId, candidateFingerprint: request.candidateFingerprint, commitIds: [...request.commitIds], blobIds: [...request.blobIds], objectSetDigest: request.objectSetDigest, passed };
	};
}

function execute(file: string, args: string[], input?: string | Buffer): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		const child = execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
			if (error) reject(new Error("approved scanner failed"));
			else resolveOutput(stdout);
		});
		child.stdin?.on("error", () => reject(new Error("approved scanner input failed")));
		child.stdin?.end(input);
	});
}

async function readBlob(cwd: string, blobId: string): Promise<Buffer> {
	const { stdout, stderr } = await new Promise<{ stdout: Buffer; stderr: Buffer }>((resolveOutput, reject) => {
		const child = execFile("git", ["cat-file", "blob", blobId], { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
			if (error) reject(new Error("outgoing Git object unavailable"));
			else resolveOutput({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
		});
	});
	if (stderr.length) throw new Error("outgoing Git object read was incomplete");
	return stdout;
}

export function parsePublicationConfig(value: unknown): PublicationGrant | undefined {
	if (!record(value) || Object.keys(value).sort().join(",") !== "actions,branchPrefix,enabled,gitlabTokenEnv,instance,maxCommits,project,pushUrl,scanner") return undefined;
	if (value.enabled !== true || typeof value.instance !== "string" || typeof value.project !== "string"
		|| typeof value.pushUrl !== "string" || typeof value.branchPrefix !== "string"
		|| !Array.isArray(value.actions) || value.actions.length !== 1 || value.actions[0] !== "push"
		|| typeof value.maxCommits !== "number" || !Number.isSafeInteger(value.maxCommits) || value.maxCommits < 1 || value.maxCommits > 100
		|| typeof value.gitlabTokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.gitlabTokenEnv)
		|| !record(value.scanner)) return undefined;
	const scanner = value.scanner;
	if (Object.keys(scanner).sort().join(",") !== "configPath,configSha256,executable,scannerId,version"
		|| typeof scanner.executable !== "string" || !isAbsolute(scanner.executable) || typeof scanner.configPath !== "string" || !isAbsolute(scanner.configPath)
		|| typeof scanner.version !== "string" || !scanner.version || typeof scanner.configSha256 !== "string"
		|| !/^[a-f0-9]{64}$/.test(scanner.configSha256) || typeof scanner.scannerId !== "string" || !/^[a-f0-9]{64}$/.test(scanner.scannerId)
		|| !/^https:\/\//.test(value.instance) || !value.project || !value.pushUrl || value.branchPrefix !== "alan/ENG-") return undefined;
	return {
		enabled: true, instance: value.instance, project: value.project, pushUrl: value.pushUrl,
		branchPrefix: value.branchPrefix, actions: ["push"],
		maxCommits: value.maxCommits, scannerId: scanner.scannerId,
	};
}

export function createPublicationRuntime(dependencies: PublicationRuntimeDependencies): PublicationRuntime {
	const grant = dependencies.grant ?? parsePublicationConfig(dependencies.config);
	const resolveTarget = dependencies.resolveTarget ?? createGitLabTargetResolver(dependencies.config, dependencies.env ?? process.env, dependencies.fetch ?? fetch);
	let clearance: PublicationClearanceResponse | undefined;
	let clearanceQueried = false;
	const loadClearance = (): PublicationClearanceResponse | undefined => {
		if (!clearanceQueried) { clearanceQueried = true; clearance = grant?.enabled ? queryClearance(dependencies.events, dependencies.cwd) : undefined; }
		return clearance;
	};
	const loadFrozenCandidate = async (): Promise<FrozenPublicationCandidate | undefined> => loadClearance()?.loadFrozenCandidate();
	const isCandidateCurrent = async (candidate: FrozenPublicationCandidate): Promise<boolean> => loadClearance()?.isCandidateCurrent(candidate) ?? false;
	let scanner: ReturnType<typeof createScannerAdapter> | undefined;
	const scan = dependencies.scan ?? (async (request: PublicationScanRequest) => {
		if (!scanner && record(dependencies.config) && record(dependencies.config.scanner)) {
			const raw = dependencies.config.scanner;
			scanner = createScannerAdapter({ cwd: dependencies.cwd, executable: String(raw.executable), version: String(raw.version), configPath: String(raw.configPath), configSha256: String(raw.configSha256), scannerId: String(raw.scannerId) });
		}
		if (!scanner) throw new Error("approved scanner configuration unavailable");
		return (await scanner)(request);
	});
	return {
		cwd: dependencies.cwd,
		loadGrant: async () => grant?.enabled ? grant : undefined,
		resolveTarget,
		loadFrozenCandidate,
		isCandidateCurrent,
		scan,
	};
}

export function pushUrlMatchesProject(pushUrl: string, instance: string, project: string): boolean {
	try {
		const base = new URL(instance);
		if (base.protocol !== "https:") return false;
		try {
			const remote = new URL(pushUrl);
			return remote.protocol === "https:" && remote.origin === base.origin && !remote.username && !remote.password
				&& remote.search === "" && remote.hash === "" && remote.pathname.replace(/\.git$/, "").replace(/\/$/, "") === `/${project}`;
		} catch {
			const match = pushUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
			return match?.[1] === base.hostname && match[2] === project;
		}
	} catch { return false; }
}

export async function loadPublicationConfig(path: string | undefined): Promise<unknown> {
	if (!path) return undefined;
	try { return JSON.parse(await readFile(path, "utf8")) as unknown; } catch { return undefined; }
}

export function createGitLabTargetResolver(
	config: unknown,
	env: Readonly<Record<string, string | undefined>>,
	fetcher: typeof fetch,
	advertise: (pushUrl: string) => Promise<PublicationTarget["advertisedRefs"] | undefined> = listAdvertisedRefs,
) {
	return async (pushUrl: string, branch: string): Promise<PublicationTarget | undefined> => {
		if (!record(config) || typeof config.instance !== "string" || !/^https:\/\//.test(config.instance)
			|| typeof config.project !== "string" || !config.project || typeof config.gitlabTokenEnv !== "string"
			|| typeof config.pushUrl !== "string" || config.pushUrl !== pushUrl) return undefined;
		const token = env[config.gitlabTokenEnv];
		if (!token || !pushUrlMatchesProject(pushUrl, config.instance, config.project)) return undefined;
		const instance = config.instance.replace(/\/$/, "");
		const encodedProject = encodeURIComponent(config.project);
		const headers = { "PRIVATE-TOKEN": token };
		try {
			const [refs, projectResponse] = await Promise.all([
				advertise(pushUrl),
				fetcher(`${instance}/api/v4/projects/${encodedProject}`, { headers, signal: AbortSignal.timeout(10_000) }),
			]);
			if (!refs || !projectResponse.ok) return undefined;
			const projectIdentity: unknown = await projectResponse.json();
			if (!record(projectIdentity) || projectIdentity.path_with_namespace !== config.project
				|| typeof projectIdentity.web_url !== "string" || new URL(projectIdentity.web_url).origin !== new URL(instance).origin
				|| !(typeof projectIdentity.id === "number" || typeof projectIdentity.id === "string")) return undefined;
			const branchResponse = await fetcher(`${instance}/api/v4/projects/${encodeURIComponent(String(projectIdentity.id))}/repository/branches/${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(10_000) });
			const branchRef = `refs/heads/${branch}`;
			if (branchResponse.status === 404) {
				if (refs.some(({ ref }) => ref === branchRef)) return undefined;
				const protection = await fetcher(`${instance}/api/v4/projects/${encodeURIComponent(String(projectIdentity.id))}/protected_branches?per_page=100`, { headers, signal: AbortSignal.timeout(10_000) });
				if (!protection.ok || protection.headers.get("x-next-page")) return undefined;
				const rules: unknown = await protection.json();
				if (!Array.isArray(rules) || rules.length >= 100 || !rules.every((rule) => record(rule) && typeof rule.name === "string" && rule.name.length > 0)) return undefined;
				const protectedBranch = rules.some((rule) => {
					const pattern = String(rule.name).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
					return new RegExp(`^${pattern}$`, "u").test(branch);
				});
				return { instance, project: config.project, protected: protectedBranch, branchState: { state: "absent" }, advertisedRefs: refs };
			}
			if (!branchResponse.ok) return undefined;
			const branchIdentity: unknown = await branchResponse.json();
			if (!record(branchIdentity) || !record(branchIdentity.commit) || typeof branchIdentity.commit.id !== "string"
				|| typeof branchIdentity.protected !== "boolean") return undefined;
			if (refs.find(({ ref }) => ref === branchRef)?.sha !== branchIdentity.commit.id) return undefined;
			return { instance, project: config.project, protected: branchIdentity.protected, branchState: { state: "existing", head: branchIdentity.commit.id }, advertisedRefs: refs };
		} catch { return undefined; }
	};
}

async function listAdvertisedRefs(pushUrl: string): Promise<PublicationTarget["advertisedRefs"] | undefined> {
	const output = await new Promise<string>((resolveOutput, reject) => {
		execFile("git", ["ls-remote", "--refs", pushUrl], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolveOutput(stdout));
	}).catch(() => undefined);
	if (output === undefined) return undefined;
	const refs: { ref: string; sha: string }[] = [];
	if (output.trim()) for (const line of output.trimEnd().split("\n")) {
		const [sha, ref, extra] = line.split("\t");
		if (extra !== undefined || !sha || !/^[a-f0-9]{40,64}$/.test(sha) || !ref?.startsWith("refs/")) return undefined;
		refs.push({ ref, sha });
	}
	if (new Set(refs.map(({ ref }) => ref)).size !== refs.length) return undefined;
	return refs.sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
}

export const DISABLED_PUBLICATION_CONFIG: PublicationRuntimeConfig = {
	enabled: false, instance: "", project: "", pushUrl: "", branchPrefix: "alan/ENG-", actions: ["push"],
	maxCommits: 0, gitlabTokenEnv: "", scanner: { executable: "", version: "", configPath: "", configSha256: "", scannerId: "" },
};
