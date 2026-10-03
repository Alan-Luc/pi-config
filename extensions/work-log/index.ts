import { spawnSync } from "node:child_process";
import { constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
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
	handoff?: string;
}

interface DecisionParams {
	kind: "decision";
	title?: string;
	summary: string;
	approach: string[];
	rationale: string;
}

export type WorkLogParams = WorkParams | DecisionParams;

const TEXT = { type: "string", minLength: 1 } as const;
const LIST = { type: "array", items: TEXT, minItems: 1 } as const;
const WORK_LOG_PARAMS = {
	anyOf: [
		{
			type: "object",
			properties: {
				kind: { const: "work" }, title: TEXT, goal: TEXT, result: TEXT, completedWork: LIST,
				changedPaths: LIST, checks: LIST, decisions: { type: "array", items: TEXT }, blockers: LIST,
				nextState: TEXT, plan: TEXT, handoff: TEXT,
			},
			required: ["kind", "title", "goal", "result", "completedWork", "changedPaths", "checks", "blockers", "nextState", "plan"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { kind: { const: "decision" }, title: TEXT, summary: TEXT, approach: LIST, rationale: TEXT },
			required: ["kind", "summary", "approach", "rationale"],
			additionalProperties: false,
		},
	],
} as const;
export interface WorkLogDetails {
	kind: "work" | "decision";
	path: string;
	duplicate: boolean;
	existingPath?: string;
}

const NO_HANDOFF = "None — no human action required";
const NEUTRAL = new Set(["", "none", "n/a"]);

type LogContext = {
	cwd: string;
	sessionManager: Pick<ExtensionToolContext["sessionManager"], "getSessionId" | "getSessionName">;
};
type MutationQueue = <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
type RecordKey = readonly ["work" | "decision", string, string, string];
type RecordFields = Partial<Record<"title" | "session" | "summary" | "result", string>>;

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

function formatEntry(params: WorkLogParams, date: ReturnType<typeof dateParts>, sessionId: string, sessionName: string): string {
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
		"",
		`**Handoff:** ${handoff}`,
	].join("\n");
}

function recordKey(kind: "work" | "decision", sessionId: string, title: string, summary: string): string {
	return JSON.stringify([kind, sessionId, title, summary] satisfies RecordKey);
}

function readRecordKeys(text: string): Set<string> {
	const keys = new Set<string>();
	let current: RecordFields = {};
	const finish = () => {
		const kind = current.summary !== undefined ? "decision" : current.result !== undefined ? "work" : undefined;
		const summary = current.summary ?? current.result;
		if (kind && current.session && current.title && summary) {
			keys.add(recordKey(kind, current.session, current.title, summary));
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
		}
	}
	finish();
	return keys;
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

function logPaths(root: string, date: ReturnType<typeof dateParts>): { canonical: string; legacy: string; relative: string } {
	const canonicalRoot = join(root, ".harness");
	const legacyRoot = join(root, ".opencode");
	const relativeDate = join(date.year, date.month, `${date.day}.md`);
	const canonical = join(canonicalRoot, relativeDate);
	const legacy = join(legacyRoot, relativeDate);
	assertContained(root, canonicalRoot, "Canonical log root");
	assertContained(root, canonical, "Canonical log path");
	assertContained(root, legacyRoot, "Legacy log root");
	assertContained(root, legacy, "Legacy log path");
	validateDirectoryChain(canonicalRoot, "Canonical log root");
	validateDirectoryChain(dirname(canonical), "Canonical log directory");
	validateLogPath(canonical, "Canonical log path");
	validateDirectoryChain(legacyRoot, "Legacy log root");
	validateDirectoryChain(dirname(legacy), "Legacy log directory");
	validateLogPath(legacy, "Legacy log path");
	return { canonical, legacy, relative: relativePath(root, canonical) };
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

async function findDuplicate(paths: readonly string[], key: string): Promise<string | undefined> {
	for (const path of paths) {
		const label = path.includes(".opencode") ? "Legacy log path" : "Canonical log path";
		if (!validateLogPath(path, label)) continue;
		if (readRecordKeys(await readLogFile(path, label)).has(key)) return path;
	}
	return undefined;
}

async function appendToPath(path: string, date: ReturnType<typeof dateParts>, entry: string): Promise<void> {
	const noFollow = constants.O_NOFOLLOW;
	if (typeof noFollow !== "number") throw new Error("This platform does not support O_NOFOLLOW for work-log writes");
	mkdirSync(dirname(path), { recursive: true });
	rejectSymlinkComponents(dirname(path), "Canonical log directory");
	const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | noFollow;
	let handle: FileHandle | undefined;
	let failure: Error | undefined;
	try {
		handle = await open(path, flags, 0o666);
		const current = await handle.readFile("utf8");
		const prefix = current.length === 0 ? `# Work log — ${date.iso}\n\n` : "\n\n";
		await handle.write(`${prefix}${entry}\n`, undefined, "utf8");
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
	const paths = logPaths(root, date);
	const title = params.kind === "decision" ? required(params.title ?? params.summary, "title") : required(params.title, "title");
	const summary = params.kind === "decision" ? required(params.summary, "summary") : required(params.result, "result");
	const key = recordKey(params.kind, sessionId, title, summary);
	const entry = formatEntry(params, date, sessionId, sessionName);

	return mutationQueue(paths.canonical, async () => {
		const duplicate = await findDuplicate([paths.canonical, paths.legacy], key);
		if (duplicate) {
			const existingPath = relativePath(root, duplicate);
			return {
				content: [{ type: "text", text: `Skipped duplicate ${params.kind} entry; existing record is ${existingPath}` }],
				details: { kind: params.kind, path: paths.relative, duplicate: true, existingPath },
			};
		}
		await appendToPath(paths.canonical, date, entry);
		return {
			content: [{ type: "text", text: `Appended ${params.kind} entry to ${paths.relative}` }],
			details: { kind: params.kind, path: paths.relative, duplicate: false },
		};
	});
}

async function executeWorkLog(params: WorkLogParams, ctx: ExtensionToolContext) {
	const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
	return appendWorkLog(params, ctx, withFileMutationQueue);
}

export default function registerWorkLog(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "work_log",
		label: "Work log",
		description: "Append a concise work or decision record to today's canonical repository work log.",
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
