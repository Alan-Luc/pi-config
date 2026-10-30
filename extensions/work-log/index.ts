import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync as readFileSyncDescriptor, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { FileHandle, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

interface WorkParams {
	kind: "work";
	title: string;
	goal: string;
	result: string;
	completedWork: string[];
	changedPaths: string[];
	checks: string[];
	decisions?: string[];
	blockers: string[];
	nextState: string;
	plan: string;
	topic?: string;
	metrics?: CompletionMetrics;
	handoff?: string;
}

interface DecisionParams {
	kind: "decision";
	title?: string;
	summary: string;
	approach: string[];
	rationale: string;
	plan: string;
	topic?: string;
}

export interface CompletionMetrics {
	activeSeconds?: number;
	pausedSeconds?: number;
	passSeconds?: number;
	children?: number;
}

interface RecoveryParams {
	kind: "recover";
	plan: string;
	topic?: string;
	expectedToken: string;
}

export type WorkLogParams = WorkParams | DecisionParams | RecoveryParams;
type RecordParams = WorkParams | DecisionParams;

const TEXT = { type: "string", minLength: 1 } as const;
const LIST = { type: "array", items: TEXT, minItems: 1 } as const;
const WORK_LOG_PARAMS = {
	type: "object",
	anyOf: [
		{
			type: "object",
			properties: {
				kind: { const: "work" }, title: TEXT, goal: TEXT, result: TEXT, completedWork: LIST,
				changedPaths: LIST, checks: LIST, decisions: { type: "array", items: TEXT }, blockers: LIST,
				nextState: TEXT, plan: { ...TEXT, description: 'An exact existing .harness/plans/YYYY-MM-DD-slug.md path, or the literal None.' }, topic: { ...TEXT, description: 'Required only with plan "None"; a lowercase 1–80 character feature slug without a date prefix.' }, metrics: { type: "object", description: "Optional completion-only self-reported annotations. Omit unknown values; not authoritative evaluation evidence.", properties: {
					activeSeconds: { type: "number", minimum: 0, description: "Focused active time in seconds." },
					pausedSeconds: { type: "number", minimum: 0, description: "Paused, blocked, or remediation time in seconds." },
					passSeconds: { type: "number", minimum: 0, description: "Freeze-to-clearance wall time, including blocked/remediation time; never sum concurrent agents." },
					children: { type: "integer", minimum: 0, description: "Unique launched child sessions, including failed/timed-out seats; exclude resumes." },
				}, additionalProperties: false }, handoff: TEXT,
			},
			required: ["kind", "title", "goal", "result", "completedWork", "changedPaths", "checks", "blockers", "nextState", "plan"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { kind: { const: "decision" }, title: TEXT, summary: TEXT, approach: LIST, rationale: TEXT, plan: { ...TEXT, description: 'An exact existing .harness/plans/YYYY-MM-DD-slug.md path, or the literal None.' }, topic: { ...TEXT, description: 'Required only with plan "None"; a lowercase 1–80 character feature slug without a date prefix.' } },
			required: ["kind", "summary", "approach", "rationale", "plan"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { kind: { const: "recover" }, plan: { ...TEXT, description: 'The exact existing plan associated with the locked topic, or None plus topic.' }, topic: TEXT, expectedToken: { ...TEXT, description: 'Exact token copied from a busy-lock diagnostic; recovery separately requires explicit user confirmation and quiescence.' } },
			required: ["kind", "plan", "expectedToken"],
			additionalProperties: false,
		},
	],
} as const;
export interface WorkLogDetails {
	kind: "work" | "decision" | "recover";
	path: string;
	duplicate: boolean;
	existingPath?: string;
}

const NO_HANDOFF = "None — no human action required";
const NEUTRAL = new Set(["", "none", "n/a"]);

type LogContext = {
	cwd: string;
	sessionManager: Pick<ExtensionToolContext["sessionManager"], "getSessionId" | "getSessionName">;
	authorizeRecovery?: (path: string, token: string) => Promise<boolean>;
};
type MutationQueue = <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
type RecordKey = readonly [string, "work" | "decision", string, string, string];
type RecordFields = Partial<Record<"title" | "session" | "summary" | "result" | "plan", string>>;

function sanitize(value: string): string {
	return value.replace(/\s+/g, " ").trim().replaceAll("`", "'");
}

function required(value: string, field: string): string {
	const cleaned = sanitize(value);
	if (!cleaned) throw new Error(`${field} must not be blank`);
	return cleaned;
}

function requiredList(values: readonly string[], field: string): string[] {
	if (values.length === 0) throw new Error(`${field} must contain at least one item`);
	return values.map((value, index) => required(value, `${field}[${index}]`));
}

function materialDecisions(values: readonly string[] | undefined): string[] {
	return (values ?? []).map(sanitize).filter((value) => !NEUTRAL.has(value.toLowerCase()));
}

function dateParts(date = new Date()): { iso: string; year: string; month: string; day: string } {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return { iso: `${year}-${month}-${day}`, year, month, day };
}

function sessionLine(sessionId: string, sessionName: string): string {
	return `**Session:** \`${sessionId}\`${sessionName ? ` (${sessionName})` : ""}`;
}

function listSection(heading: string, values: readonly string[]): string[] {
	return ["", `**${heading}:**`, ...values.map((value) => `- ${value}`)];
}

function validateMetrics(metrics: CompletionMetrics | undefined): CompletionMetrics | undefined {
	if (!metrics) return undefined;
	const validated: CompletionMetrics = {};
	for (const field of ["activeSeconds", "pausedSeconds", "passSeconds", "children"] as const) {
		const value = metrics[field];
		if (value === undefined) continue;
		if (!Number.isFinite(value) || value < 0 || (field === "children" && !Number.isInteger(value))) {
			throw new Error(`metrics.${field} must be a finite nonnegative ${field === "children" ? "integer" : "number"}`);
		}
		validated[field] = value;
	}
	return validated;
}

function metricSection(metrics: CompletionMetrics | undefined): string[] {
	const validated = validateMetrics(metrics);
	if (!validated) return [];
	const values = Object.entries(validated).filter(([, value]) => value !== undefined);
	return values.length ? ["", "**Completion metrics:**", ...values.map(([field, value]) => `- ${field}: ${value}`)] : [];
}

function formatEntry(params: RecordParams, date: ReturnType<typeof dateParts>, sessionId: string, sessionName: string): string {
	if (params.kind === "decision") {
		const title = required(params.title ?? params.summary, "title");
		const summary = required(params.summary, "summary");
		const approach = requiredList(params.approach, "approach");
		const rationale = required(params.rationale, "rationale");
		return [
			`## ${date.iso} — ${title}`,
			"",
			sessionLine(sessionId, sessionName),
			"",
			`**Summary:** ${summary}`,
			...listSection("Approach", approach),
			"",
			`**Rationale:** ${rationale}`,
			"",
			`**Plan:** ${required(params.plan, "plan")}`,
			...(params.topic ? [`**Topic:** ${required(params.topic, "topic")}`] : []),
		].join("\n");
	}

	const completedWork = requiredList(params.completedWork, "completedWork");
	const changedPaths = requiredList(params.changedPaths, "changedPaths");
	const checks = requiredList(params.checks, "checks");
	const blockers = requiredList(params.blockers, "blockers");
	const decisions = materialDecisions(params.decisions);
	const handoff = required(params.handoff ?? NO_HANDOFF, "handoff");
	return [
		`## ${date.iso} — ${required(params.title, "title")}`,
		"",
		sessionLine(sessionId, sessionName),
		"",
		`**Goal:** ${required(params.goal, "goal")}`,
		"",
		`**Result:** ${required(params.result, "result")}`,
		...listSection("Completed work", completedWork),
		...listSection("Changed paths / artifacts", changedPaths),
		...listSection("Checks", checks),
		...(decisions.length ? listSection("Decisions / constraints", decisions) : []),
		...listSection("Blockers", blockers),
		"",
		`**Next state:** ${required(params.nextState, "nextState")}`,
		"",
		`**Plan:** ${required(params.plan, "plan")}`,
		...(params.topic ? [`**Topic:** ${required(params.topic, "topic")}`] : []),
		...metricSection(params.metrics),
		"",
		`**Handoff:** ${handoff}`,
	].join("\n");
}

function recordKey(topic: string, kind: "work" | "decision", sessionId: string, title: string, summary: string): string {
	return JSON.stringify([topic, kind, sessionId, title, summary] satisfies RecordKey);
}

function readRecordKeys(text: string, topic: string, legacyPlan?: string): Set<string> {
	const keys = new Set<string>();
	let current: RecordFields = {};
	const finish = () => {
		const kind = current.summary !== undefined ? "decision" : current.result !== undefined ? "work" : undefined;
		const summary = current.summary ?? current.result;
		if (kind && current.session && current.title && summary
			&& (legacyPlan === undefined || (legacyPlan !== "None" && kind === "work" && current.plan === legacyPlan))) {
			keys.add(recordKey(topic, kind, current.session, current.title, summary));
		}
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			finish();
			const match = /^## [^—]+ — (.+)$/.exec(line);
			current = match ? { title: match[1].trim() } : {};
		} else if (line.startsWith("**Session:** `")) {
			const match = /^\*\*Session:\*\* `([^`]+)`/.exec(line);
			if (match) current.session = match[1];
		} else if (line.startsWith("**Summary:** ")) {
			current.summary = line.slice("**Summary:** ".length).trim();
		} else if (line.startsWith("**Result:** ")) {
			current.result = line.slice("**Result:** ".length).trim();
		} else if (line.startsWith("**Plan:** ")) {
			current.plan = line.slice("**Plan:** ".length).trim();
		}
	}
	finish();
	return keys;
}

interface LockOwner {
	pid: number;
	session: string;
	createdAt: string;
	token: string;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
	if (!validateLogPath(lockPath, "Topic lock owner")) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(await readLogFile(lockPath, "Topic lock owner"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	if (!isRecord(value) || typeof value.pid !== "number" || typeof value.session !== "string" || typeof value.createdAt !== "string" || typeof value.token !== "string") return undefined;
	return { pid: value.pid, session: value.session, createdAt: value.createdAt, token: value.token };
}

function ownerDescription(owner: LockOwner | undefined): string {
	return owner
		? `pid=${owner.pid}, session=${owner.session}, created=${owner.createdAt}, token=${owner.token}`
		: "owner details unavailable or malformed";
}

async function withTopicLock<T>(path: string, session: string, operation: () => Promise<T>): Promise<T> {
	mkdirSync(dirname(path), { recursive: true });
	rejectSymlinkComponents(dirname(path), "Canonical log directory");
	const lockPath = `${path}.lock`;
	const owner: LockOwner = { pid: process.pid, session, createdAt: new Date().toISOString(), token: randomUUID() };
	const candidatePath = `${lockPath}.candidate-${owner.token}`;
	let acquired = false;
	let operationError: Error | undefined;
	try {
		writeFileSync(candidatePath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
		const descriptor = openSync(candidatePath, constants.O_WRONLY);
		try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
		for (let attempt = 0; attempt < 21; attempt++) {
			rejectSymlinkComponents(lockPath, "Topic lock");
			try {
				// Publish complete owner metadata atomically with exclusive lock acquisition.
				linkSync(candidatePath, lockPath);
				acquired = true;
				break;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				if (attempt === 20) {
					let heldBy: LockOwner | undefined;
					try { heldBy = await readLockOwner(lockPath); } catch { heldBy = undefined; }
					throw new Error(`Topic log is busy: ${path}; ${ownerDescription(heldBy)}. Retry later or use explicit token recovery only after the owner is proven quiescent.`);
				}
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
		}
		if (!acquired) throw new Error(`Cannot acquire topic lock for ${path}`);
		unlinkSync(candidatePath);
		return await operation();
	} catch (error) {
		operationError = error instanceof Error ? error : new Error(describeError(error), { cause: error });
		throw operationError;
	} finally {
		const cleanupErrors: Error[] = [];
		try {
			if (existingStat(candidatePath)) unlinkSync(candidatePath);
		} catch (error) {
			cleanupErrors.push(new Error(`Cannot remove topic lock candidate ${candidatePath}: ${describeError(error)}`, { cause: error }));
		}
		if (acquired) {
			try {
				const heldBy = await readLockOwner(lockPath);
				if (heldBy?.token !== owner.token) throw new Error(`Topic lock ownership changed for ${path}; preserved ${lockPath}.`);
				unlinkSync(lockPath);
			} catch (error) {
				cleanupErrors.push(new Error(`Cannot release topic lock ${lockPath}: ${describeError(error)}`, { cause: error }));
			}
		}
		if (cleanupErrors.length) {
			const errors = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
			const [firstCleanupError] = cleanupErrors;
			if (!operationError && cleanupErrors.length === 1 && firstCleanupError) throw firstCleanupError;
			throw new AggregateError(errors, `Topic lock cleanup failed for ${path}`);
		}
	}
}

function recoverTopicLock(path: string, expectedToken: string): void {
	const lockPath = `${path}.lock`;
	rejectSymlinkComponents(lockPath, "Topic lock");
	const ownerText = readFileSyncNoFollow(lockPath);
	const owner = parseLockOwner(ownerText);
	if (owner.token !== expectedToken) {
		throw new Error(`Topic lock token changed for ${path}; expected token did not match ${owner.token}. Nothing was removed.`);
	}
	const quarantine = `${lockPath}.quarantine-${randomUUID()}`;
	// Isolate the expected owner so a replacement lock is never removed by recovery.
	renameSync(lockPath, quarantine);
	try {
		const quarantinedOwner = parseLockOwner(readFileSyncNoFollow(quarantine));
		if (quarantinedOwner.token !== expectedToken) {
			throw new Error(`Quarantined lock token changed for ${path}; preserved quarantine at ${quarantine}. Nothing was removed.`);
		}
		unlinkSync(quarantine);
	} catch (error) {
		if (existingStat(quarantine)) throw new Error(`${describeError(error)}; preserved quarantine at ${quarantine}`);
		throw error;
	}
}

function readFileSyncNoFollow(path: string): string {
	if (!validateLogPath(path, "Topic lock owner")) throw new Error(`Topic lock owner is missing: ${path}`);
	const noFollow = constants.O_NOFOLLOW;
	if (typeof noFollow !== "number") throw new Error("O_NOFOLLOW is unavailable for topic lock recovery");
	const descriptor = openSync(path, constants.O_RDONLY | noFollow);
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error(`Topic lock owner must be a regular file: ${path}`);
		return readFileSyncDescriptor(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

function parseLockOwner(text: string): LockOwner {
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error("Topic lock owner record is malformed"); }
	if (typeof value !== "object" || value === null) throw new Error("Topic lock owner record is malformed");
	if (!isRecord(value) || typeof value.pid !== "number" || typeof value.session !== "string" || typeof value.createdAt !== "string" || typeof value.token !== "string") {
		throw new Error("Topic lock owner record is malformed");
	}
	return { pid: value.pid, session: value.session, createdAt: value.createdAt, token: value.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function closeFileHandle(
	handle: FileHandle | undefined,
	context: string,
	primary: Error | undefined,
): Promise<Error | undefined> {
	if (!handle) return primary;
	try {
		await handle.close();
		return primary;
	} catch (error) {
		const closeError = new Error(`Cannot close ${context}: ${describeError(error)}`, { cause: error });
		return primary
			? new AggregateError([primary, closeError], `${primary.message}; also failed to close ${context}`)
			: closeError;
	}
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function rejectSymlinkComponents(path: string, label: string): void {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	let current = root;
	for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			if (lstatSync(current).isSymbolicLink()) {
				throw new Error(`Refusing ${label} through symlink: ${current}`);
			}
		} catch (error) {
			if (errorCode(error) === "ENOENT") break;
			throw error;
		}
	}
}

function existingStat(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function validateDirectoryChain(path: string, label: string): void {
	rejectSymlinkComponents(path, label);
	const absolute = resolve(path);
	const root = parse(absolute).root;
	let current = root;
	for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, component);
		const stat = existingStat(current);
		if (!stat) break;
		if (!stat.isDirectory()) throw new Error(`${label} component is not a directory: ${current}`);
	}
}

function validateLogPath(path: string, label: string): boolean {
	rejectSymlinkComponents(path, label);
	const stat = existingStat(path);
	if (stat && !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
	return stat !== undefined;
}

function assertContained(root: string, path: string, label: string): void {
	const relativePath = relative(root, path);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`${label} is outside the verified repository root: ${path}`);
	}
}

function gitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.startsWith("GIT_")) delete environment[key];
	}
	environment.LC_ALL = "C";
	environment.LANG = "C";
	return environment;
}

function hasGitMetadata(path: string): boolean {
	let current = resolve(path);
	while (true) {
		if (existingStat(join(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function resolveRepositoryRoot(cwd: string): string {
	const inputCwd = resolve(cwd);
	const cwdStat = existingStat(inputCwd);
	if (!cwdStat?.isDirectory()) throw new Error(`ctx.cwd must be an existing directory: ${cwd}`);
	if (cwdStat.isSymbolicLink()) throw new Error(`ctx.cwd must not be a symlink: ${cwd}`);
	const verifiedCwd = realpathSync(inputCwd);
	validateDirectoryChain(verifiedCwd, "ctx.cwd");

	const result = spawnSync("git", ["-C", verifiedCwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: gitEnvironment(),
	});
	const stdout = result.stdout?.toString().trim() ?? "";
	const stderr = result.stderr?.toString().trim() ?? "";
	if (result.error) {
		throw new Error(`Cannot invoke Git while resolving root from ${verifiedCwd}: ${describeError(result.error)}`, {
			cause: result.error,
		});
	}
	if (result.signal) {
		throw new Error(`Git root lookup from ${verifiedCwd} was terminated by ${result.signal}`);
	}
	if (result.status === null) {
		throw new Error(`Git root lookup from ${verifiedCwd} did not return an exit status`);
	}
	if (result.status !== 0) {
		const notRepository = /^fatal: not a git repository(?:\s|$)/m.test(stderr);
		if (result.status === 128 && notRepository && !hasGitMetadata(verifiedCwd)) return verifiedCwd;
		throw new Error(
			`Git root lookup failed from ${verifiedCwd} with exit ${result.status}: ${stderr || "no diagnostics"}`,
		);
	}
	if (stderr) throw new Error(`Git root lookup from ${verifiedCwd} emitted diagnostics: ${stderr}`);
	if (!stdout || stdout.includes("\n")) throw new Error(`Git returned an empty or invalid repository root from ${verifiedCwd}`);

	const root = resolve(stdout);
	validateDirectoryChain(root, "Git root");
	const stat = existingStat(root);
	if (!stat?.isDirectory()) throw new Error(`Git root is not an existing directory: ${root}`);
	const cwdFromRoot = relative(root, verifiedCwd);
	if (cwdFromRoot === ".." || cwdFromRoot.startsWith(`..${sep}`) || isAbsolute(cwdFromRoot)) {
		throw new Error(`Git root is outside ctx.cwd ancestry: ${root}`);
	}
	return root;
}

function relativePath(root: string, path: string): string {
	const value = relative(root, path).split(sep).join("/");
	if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) {
		throw new Error(`Cannot produce a repository-relative path for ${path}`);
	}
	return value;
}

function logPaths(root: string, date: ReturnType<typeof dateParts>, key: string): { canonical: string; daily: string; legacy: string; relative: string } {
	const canonicalRoot = join(root, ".harness");
	const canonical = join(canonicalRoot, date.year, date.month, date.day, `${key}.md`);
	const daily = join(canonicalRoot, date.year, date.month, `${date.day}.md`);
	const legacyRoot = join(root, ".opencode");
	const legacy = join(legacyRoot, date.year, date.month, `${date.day}.md`);
	assertContained(root, canonicalRoot, "Canonical log root");
	assertContained(root, canonical, "Canonical topic log path");
	validateDirectoryChain(canonicalRoot, "Canonical log root");
	validateDirectoryChain(dirname(canonical), "Canonical topic log directory");
	validateLogPath(canonical, "Canonical topic log path");
	for (const [path, label] of [[daily, "Historical daily log path"], [legacy, "Legacy log path"]] as const) {
		assertContained(root, path, label);
		validateDirectoryChain(dirname(path), `${label} directory`);
		validateLogPath(path, label);
	}
	return { canonical, daily, legacy, relative: relativePath(root, canonical) };
}

function topicKey(root: string, plan: string, topic: string | undefined): string {
	if (plan === "None") {
		if (!topic || !/^(?!\d{4}-\d{2}-\d{2})(?=.{1,80}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) {
			throw new Error('For plan "None", supply topic as a 1–80 character lowercase slug without a date prefix.');
		}
		return topic;
	}
	if (topic !== undefined) throw new Error('Do not supply topic with a plan; use plan "None" and a feature topic instead.');
	const match = /^\.harness\/plans\/(\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(plan);
	if (!match) throw new Error('Use a canonical .harness/plans/YYYY-MM-DD-slug.md plan, or plan "None" with a lowercase topic slug.');
	const planDate = match[1].slice(0, 10);
	const parsedDate = Date.parse(`${planDate}T00:00:00.000Z`);
	if (!Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== planDate) {
		throw new Error("plan filename date must be a valid YYYY-MM-DD calendar date.");
	}
	const planPath = join(root, ...plan.split("/"));
	validateDirectoryChain(dirname(planPath), "Plan directory");
	if (!validateLogPath(planPath, "Plan path")) throw new Error(`Plan does not exist: ${plan}; create that canonical plan or use plan "None" with topic.`);
	return match[1];
}

async function readLogFile(path: string, label: string): Promise<string> {
	const noFollow = constants.O_NOFOLLOW;
	if (typeof noFollow !== "number") throw new Error(`Cannot inspect ${label} ${path}: O_NOFOLLOW is unavailable`);
	let handle: FileHandle | undefined;
	let content: string | undefined;
	let failure: Error | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow);
		if (!(await handle.stat()).isFile()) throw new Error(`${label} must be a regular file: ${path}`);
		content = await handle.readFile("utf8");
	} catch (error) {
		failure = new Error(`Cannot inspect ${label} ${path}: ${describeError(error)}`, { cause: error });
	}
	failure = await closeFileHandle(handle, `${label} ${path}`, failure);
	if (failure) throw failure;
	if (content === undefined) throw new Error(`Cannot inspect ${label} ${path}: read produced no content`);
	return content;
}

async function findDuplicate(paths: readonly string[], key: string, topic: string, plan: string): Promise<string | undefined> {
	for (const [index, path] of paths.entries()) {
		const oldDaily = index > 0;
		const label = path.includes(".opencode") ? "Legacy log path" : oldDaily ? "Historical daily log path" : "Canonical topic log path";
		if (!validateLogPath(path, label)) continue;
		if (readRecordKeys(await readLogFile(path, label), topic, oldDaily ? plan : undefined).has(key)) return path;
	}
	return undefined;
}

async function appendToPath(path: string, date: ReturnType<typeof dateParts>, topic: string, plan: string, entry: string): Promise<void> {
	const noFollow = constants.O_NOFOLLOW;
	if (typeof noFollow !== "number") throw new Error("This platform does not support O_NOFOLLOW for work-log writes");
	mkdirSync(dirname(path), { recursive: true });
	rejectSymlinkComponents(dirname(path), "Canonical log directory");
	const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow;
	let handle: FileHandle | undefined;
	let failure: Error | undefined;
	try {
		handle = await open(path, flags, 0o666);
		const prefix = (await handle.stat()).size === 0 ? `# Work log — ${date.iso} — ${topic}\n\n**Plan:** ${plan}\n\n` : "\n\n";
		await handle.writeFile(`${prefix}${entry}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		failure = new Error(`Cannot append canonical work log ${path}: ${describeError(error)}`, { cause: error });
	}
	failure = await closeFileHandle(handle, `canonical work log ${path}`, failure);
	if (failure) throw failure;
}

export async function appendWorkLog(
	params: WorkLogParams,
	ctx: LogContext,
	mutationQueue: MutationQueue,
): Promise<{ content: [{ type: "text"; text: string }]; details: WorkLogDetails }> {
	const date = dateParts();
	const sessionId = required(sanitize(ctx.sessionManager.getSessionId()), "session id");
	const sessionName = sanitize(ctx.sessionManager.getSessionName() ?? "");
	const root = resolveRepositoryRoot(ctx.cwd);
	const plan = required(params.plan, "plan");
	if (plan !== params.plan) throw new Error("plan must be an exact canonical path or the literal None; whitespace normalization is not accepted.");
	const topic = topicKey(root, plan, params.topic);
	const paths = logPaths(root, date, topic);
	if (params.kind === "recover") {
		const expectedToken = required(params.expectedToken, "expectedToken");
		if (expectedToken !== params.expectedToken) throw new Error("expectedToken must exactly match the owner token without normalization.");
		if (!ctx.authorizeRecovery || !(await ctx.authorizeRecovery(paths.canonical, expectedToken))) {
			throw new Error("Topic lock recovery requires explicit authorization and confirmed topic-wide writer quiescence.");
		}
		recoverTopicLock(paths.canonical, expectedToken);
		return {
			content: [{ type: "text", text: `Recovered the matching topic lock for ${paths.relative}; verified quiescence is required before this explicit operation.` }],
			details: { kind: "recover", path: paths.relative, duplicate: false },
		};
	}
	const title = params.kind === "decision" ? required(params.title ?? params.summary, "title") : required(params.title, "title");
	const summary = params.kind === "decision" ? required(params.summary, "summary") : required(params.result, "result");
	const key = recordKey(topic, params.kind, sessionId, title, summary);
	const entry = formatEntry(params, date, sessionId, sessionName);

	return mutationQueue(paths.canonical, () => withTopicLock(paths.canonical, sessionId, async () => {
		const duplicate = await findDuplicate([paths.canonical, paths.daily, paths.legacy], key, topic, plan);
		if (duplicate) {
			const existingPath = relativePath(root, duplicate);
			return {
				content: [{ type: "text", text: `Skipped duplicate ${params.kind} entry; existing record is ${existingPath}` }],
				details: { kind: params.kind, path: existingPath, duplicate: true, existingPath },
			};
		}
		await appendToPath(paths.canonical, date, topic, plan, entry);
		return {
			content: [{ type: "text", text: `Appended ${params.kind} entry to ${paths.relative}` }],
			details: { kind: params.kind, path: paths.relative, duplicate: false },
		};
	}));
}

async function executeWorkLog(params: WorkLogParams, ctx: ExtensionToolContext) {
	const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
	const authorizeRecovery = async (path: string, token: string): Promise<boolean> => {
		if (!ctx.hasUI) return false;
		return ctx.ui.confirm(`Recover ${path}.lock only after confirming all writers are quiescent. Expected owner token: ${token}`, "Authorize work-log lock recovery");
	};
	return appendWorkLog(params, { cwd: ctx.cwd, sessionManager: ctx.sessionManager, authorizeRecovery }, withFileMutationQueue);
}

export default function registerWorkLog(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "work_log",
		label: "Work log",
		description: "Append work or decision records to today's plan/topic log. Optional finite nonnegative work metrics are self-reported annotations, not evaluation evidence. A recover request requires Alan's explicit authorization and proof the topic writer is quiescent; never recover from age or PID alone.",
		promptSnippet: "Append a verified work or decision record",
		parameters: WORK_LOG_PARAMS,
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		execute: async (
			_toolCallId: string,
			params: WorkLogParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<WorkLogDetails> | undefined,
			ctx: ExtensionToolContext,
		) => executeWorkLog(params, ctx),
	});
}
