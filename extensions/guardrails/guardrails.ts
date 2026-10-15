import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";

// Keep review artifacts inside Pi's runtime-specific temporary directory.
export const REVIEW_ARTIFACT_ROOT = resolve(tmpdir(), "pi");

const TEST_COMMAND_RE = /\b(?:manage\.py\s+test|pytest|pytests?|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|go\s+test|cargo\s+test|jest|vitest|mocha|rspec|phpunit|gradle\s+test|mvn\s+test)\b/i;
const DB_BLOCKER_RE = /(?:ECONNREFUSED|connection refused|could not connect to server|unable to create a connection to the 'postgres' database|database .*?(?:unavailable|down)|db(?:\s+)?(?:blocked|down)|OperationalError|timeout(?:ed)? out|no route to host|temporary failure in name resolution|psql: error|mysql:.*(?:gone away|can't connect)|sqlite.*locked|localhost:55432)/i;
const ALLOW_INFRA_RETRY_RE = /\bPI_ALLOW_INFRA_RETRY=1\b/;
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree"]);
const GIT_PUSH_OPTIONS_WITH_VALUES = new Set(["--exec", "--push-option", "--receive-pack", "--repo", "--upload-pack", "-o"]);
const GIT_WORKTREE_OPTIONS = new Set(["--checkout", "--detach", "--force", "--lock", "--no-checkout", "-f"]);
const GIT_WORKTREE_OPTIONS_WITH_VALUES = new Set(["--reason"]);
type RecordValue = Record<string, unknown>;
type ShellCommand = string[];

type CheckResult = { block: false } | { block: true; reason: string };

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isContained(parent: string, candidate: string): boolean {
	const nested = relative(parent, candidate);
	return Boolean(nested) && nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function hasParentTraversal(value: string): boolean {
	return value.split(sep === "\\" ? /[\\/]/ : "/").includes("..");
}

function hasAmbiguousExpansion(value: string): boolean {
	return /[$`*?\[\]{}~]/.test(value);
}

async function requireNoSymlinkTraversal(candidate: string, boundary: string, label: string): Promise<void> {
	for (let current = candidate; ; current = dirname(current)) {
		if (current !== boundary && !isContained(boundary, current)) {
			throw new Error(`${label} escapes its allowed boundary: ${candidate}`);
		}
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} cannot traverse a symbolic link: ${current}`);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
		if (current === boundary) return;
	}
}

async function resolvePhysicalCandidate(base: string, value: string): Promise<string> {
	const root = isAbsolute(value) ? parse(value).root : "";
	let current = root || base;
	for (const segment of value.slice(root.length).split(sep === "\\" ? /[\\/]/ : "/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			current = dirname(current);
			continue;
		}
		const next = resolve(current, segment);
		try {
			current = (await lstat(next)).isSymbolicLink() ? await realpath(next) : next;
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
			current = next;
		}
	}
	return current;
}

async function requireReviewArtifact(value: string): Promise<Buffer> {
	if (hasParentTraversal(value)) throw new Error(`Patch artifact cannot contain parent traversal: ${value}`);
	const candidate = resolve(value);
	if (!isAbsolute(value) || !isContained(REVIEW_ARTIFACT_ROOT, candidate)) {
		throw new Error(`Patch artifact must be an absolute path lexically contained under ${REVIEW_ARTIFACT_ROOT}: ${value || "<empty>"}`);
	}
	let stat;
	try {
		stat = await lstat(candidate);
	} catch (error) {
		if (hasCode(error, "ENOENT")) throw new Error(`Patch artifact does not exist: ${candidate}`);
		throw new Error(`Could not inspect Patch artifact ${candidate}: ${errorMessage(error)}`);
	}
	if (stat.isSymbolicLink()) throw new Error(`Patch artifact cannot be a symbolic link: ${candidate}`);
	if (!stat.isFile()) throw new Error(`Patch artifact must be a regular file: ${candidate}`);
	await requireNoSymlinkTraversal(dirname(candidate), REVIEW_ARTIFACT_ROOT, "Patch artifact");
	try {
		return await readFile(candidate);
	} catch (error) {
		throw new Error(`Could not read Patch artifact ${candidate}: ${errorMessage(error)}`);
	}
}

async function validateBoundedReview(input: unknown): Promise<void> {
	const launches: RecordValue[] = [];
	if (!isRecord(input)) return;
	if (Array.isArray(input.children) && input.children.length > 0) {
		for (const child of input.children) if (isRecord(child)) launches.push(child);
	} else {
		launches.push(input);
	}
	for (const launch of launches) {
		if (launch.agent !== "code-reviewer") continue;
		const task = typeof launch.task === "string" ? launch.task : "";
		const artifactMatch = task.match(/^Patch artifact:[ \t]*(.*)$/im);
		const reviewPathsMatch = task.match(/^Review paths:[ \t]*(.*)$/im);
		const excludedPreDirtyPathsMatch = task.match(/^Excluded pre-dirty paths:[ \t]*(.*)$/im);
		const candidateMatch = task.match(/^Candidate:[ \t]*(candidate_[0-9a-f]{64})$/im);
		const patchHashMatch = task.match(/^Patch SHA-256:[ \t]*([0-9a-f]{64})$/im);
		const reviewPathsText = reviewPathsMatch?.[1].trim() ?? "";
		let reviewPaths: string[] = [];
		if (reviewPathsText.startsWith("[")) {
			try {
				const parsed: unknown = JSON.parse(reviewPathsText);
				if (Array.isArray(parsed) && parsed.every((path): path is string => typeof path === "string")) reviewPaths = parsed;
			} catch {
				reviewPaths = [];
			}
		} else {
			reviewPaths = reviewPathsText.split(/[ \t]+/).filter(Boolean);
		}
		let excludedPreDirtyPaths: string[] | undefined;
		try {
			const parsed: unknown = JSON.parse(excludedPreDirtyPathsMatch?.[1].trim() ?? "");
			if (Array.isArray(parsed) && parsed.every((path): path is string => typeof path === "string")) excludedPreDirtyPaths = parsed;
		} catch {
			excludedPreDirtyPaths = undefined;
		}
		if (
			!artifactMatch
			|| reviewPaths.length === 0
			|| reviewPaths.some((path) => !isAbsolute(path))
			|| excludedPreDirtyPaths === undefined
			|| excludedPreDirtyPaths.some((path) => !isAbsolute(path))
			|| !candidateMatch
			|| !patchHashMatch
		) {
			throw new Error(`Blocked unbounded code-reviewer task; use generated review metadata:\nCandidate: candidate_<id>\nPatch SHA-256: <sha256>\nPatch artifact: ${resolve(REVIEW_ARTIFACT_ROOT, "<name>.patch")}\nReview paths: <exact absolute paths>\nExcluded pre-dirty paths: <exact absolute paths excluded from the patch>`);
		}
		const artifactBytes = await requireReviewArtifact(artifactMatch[1].trim());
		const actualPatchSha256 = createHash("sha256").update(artifactBytes).digest("hex");
		if (actualPatchSha256 !== patchHashMatch[1]) {
			throw new Error(`Patch artifact SHA-256 does not match generated Patch SHA-256: expected ${patchHashMatch[1]}, got ${actualPatchSha256}`);
		}
	}
}

function tokenizeShell(command: string): ShellCommand[] | undefined {
	const commands: ShellCommand[] = [];
	let current: ShellCommand = [];
	let token = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const pushToken = () => { if (started) current.push(token); token = ""; started = false; };
	const pushCommand = () => { pushToken(); if (current.length) commands.push(current); current = []; };
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) { token += character; started = true; escaped = false; continue; }
		if (quote === "'") { if (character === "'") quote = undefined; else token += character; started = true; continue; }
		if (quote === '"') { if (character === '"') quote = undefined; else if (character === "\\") escaped = true; else token += character; started = true; continue; }
		if (character === "'" || character === '"') { quote = character; started = true; continue; }
		if (character === "\\") { escaped = true; started = true; continue; }
		if (/\s/.test(character)) { pushToken(); continue; }
		if (character === ";" || character === "\n" || character === "|" || character === "&" || character === "(") { pushCommand(); if ((character === "|" || character === "&") && command[index + 1] === character) index += 1; continue; }
		if (character === ")") { pushCommand(); continue; }
		token += character; started = true;
	}
	if (quote || escaped) return undefined;
	pushCommand();
	return commands;
}

function isAssignment(value: string | undefined): boolean { return Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(value)); }
function isGit(value: string | undefined): boolean { return value === "git" || Boolean(value && /(?:^|\/)git$/.test(value)); }

function isVerificationIndexCommand(command: string): boolean {
	const commands = tokenizeShell(command);
	if (!commands || commands.length !== 2) return false;
	const [changeDirectory, gitCommand] = commands;
	if (changeDirectory.length !== 2 || changeDirectory[0] !== "cd" || !isAbsolute(changeDirectory[1])) return false;
	const isAdd = gitCommand.length === 4 && gitCommand[1] === "git" && gitCommand[2] === "add" && gitCommand[3] === "-A";
	const isWriteTree = gitCommand.length === 3 && gitCommand[1] === "git" && gitCommand[2] === "write-tree";
	if ((!isAdd && !isWriteTree) || !gitCommand[0].startsWith("GIT_INDEX_FILE=")) return false;
	const indexPath = gitCommand[0].slice("GIT_INDEX_FILE=".length);
	const indexDirectory = dirname(indexPath);
	return isAbsolute(indexPath)
		&& basename(indexPath) === "index"
		&& /^pi-verification-index-[^/]+$/.test(basename(indexDirectory))
		&& dirname(indexDirectory) === resolve(tmpdir());
}

function directGit(command: ShellCommand, allowGitIndexFile: boolean): string[] | undefined {
	let index = 0;
	while (isAssignment(command[index])) {
		const retarget = command[index].match(/^(GIT_[A-Z0-9_]*)(\+?=)/);
		if (retarget && (!allowGitIndexFile || retarget[1] !== "GIT_INDEX_FILE" || retarget[2] !== "=")) {
			throw new Error("Blocked direct Git invocation with GIT_* environment retargeting");
		}
		index += 1;
	}
	return isGit(command[index]) ? command.slice(index) : undefined;
}

function parseGit(tokens: string[], workdir: string): { name: string; args: string[]; workdir: string } | undefined {
	let skippedOption = false;
	let gitWorkdir = workdir;
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "-C") {
			if (index + 1 >= tokens.length) return undefined;
			if (hasParentTraversal(tokens[index + 1]) || hasAmbiguousExpansion(tokens[index + 1])) throw new Error("Blocked ambiguous direct Git -C path");
			gitWorkdir = resolve(gitWorkdir, tokens[index + 1]); index += 1; continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			if (hasParentTraversal(token.slice(2)) || hasAmbiguousExpansion(token.slice(2))) throw new Error("Blocked ambiguous direct Git -C path");
			gitWorkdir = resolve(gitWorkdir, token.slice(2)); continue;
		}
		if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token)) { if (index + 1 >= tokens.length) return undefined; index += 1; continue; }
		if (token.startsWith("--") && token.includes("=")) { skippedOption = true; continue; }
		if (token.startsWith("-")) { skippedOption = true; continue; }
		if (skippedOption && tokens.slice(index + 1).some((value) => value === "push" || value === "worktree")) throw new Error("Blocked ambiguous direct Git mutation syntax; Git options cannot be unambiguously parsed");
		return { name: token, args: tokens.slice(index + 1), workdir: gitWorkdir };
	}
	return undefined;
}

function hasCommitNoVerify(args: string[]): boolean {
	const valueFlags = new Set(["C", "F", "c", "m"]);
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === "--") return false;
		if (!/^-[^-]/.test(token)) continue;
		const flags = token.slice(1);
		for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
			const flag = flags[flagIndex];
			if (flag === "n") return true;
			if (!valueFlags.has(flag)) continue;
			if (flagIndex === flags.length - 1) index += 1;
			break;
		}
	}
	return false;
}

function pushPositionals(args: string[]): string[] {
	const positionals: string[] = [];
	let ended = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!ended && token === "--") { ended = true; continue; }
		if (!ended && token.startsWith("-") && token !== "-") {
			if (GIT_PUSH_OPTIONS_WITH_VALUES.has(token)) { if (index + 1 >= args.length) throw new Error(`Blocked direct git push; option ${token} needs a value`); index += 1; }
			continue;
		}
		positionals.push(token);
	}
	return positionals;
}

function validatePush(args: string[]): void {
	if (args.some(hasAmbiguousExpansion)) throw new Error("Blocked direct git push; shell expansion cannot define the remote, options, or branch");
	if (args.some((token) => token === "--repo" || token.startsWith("--repo="))) throw new Error("Blocked direct git push; --repo cannot override the required origin remote");
	const positionals = pushPositionals(args);
	if (positionals.length !== 2 || positionals[0] !== "origin") throw new Error("Blocked direct git push; use exactly the explicit positional shape `origin <branch>`");
	const branch = positionals[1];
	if (!branch || branch === "HEAD" || branch.includes(":") || branch.startsWith("+") || hasAmbiguousExpansion(branch)) throw new Error("Blocked direct git push; branch must be an explicit non-HEAD, non-refspec branch");
}

function worktreeDestination(args: string[]): string {
	let ended = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!ended && token === "--") { ended = true; continue; }
		if (!ended && token.startsWith("-") && token !== "-") {
			if (token === "-b" || token === "-B") { if (index + 1 >= args.length) throw new Error("Blocked direct git worktree add; branch or option value is missing"); index += 1; continue; }
			if (token.startsWith("-b") || token.startsWith("-B")) continue;
			if (GIT_WORKTREE_OPTIONS_WITH_VALUES.has(token)) { if (index + 1 >= args.length) throw new Error(`Blocked direct git worktree add; option ${token} needs a value`); index += 1; continue; }
			if (!GIT_WORKTREE_OPTIONS.has(token)) throw new Error(`Blocked ambiguous direct git worktree add option: ${token}`);
			continue;
		}
		return token;
	}
	throw new Error("Blocked direct git worktree add; destination is required");
}

async function validateWorktree(args: string[], projectRoot: string, workdir: string): Promise<void> {
	const destination = worktreeDestination(args);
	let physicalRoot: string;
	let physicalWorkdir: string;
	try { physicalRoot = await realpath(projectRoot); physicalWorkdir = await realpath(workdir); }
	catch (error) { throw new Error(`Could not inspect Git working directory ${workdir}: ${errorMessage(error)}`); }
	const worktreeRoot = resolve(physicalRoot, ".harness", "worktrees");
	const candidate = await resolvePhysicalCandidate(physicalWorkdir, destination);
	if (!destination || hasAmbiguousExpansion(destination) || !isContained(worktreeRoot, candidate)) throw new Error(`Blocked direct git worktree add; destination is outside the allowed non-empty child path under ${worktreeRoot}: ${destination || "<empty>"}`);
	await requireNoSymlinkTraversal(candidate, worktreeRoot, "Git worktree destination");
}

const SUBAGENT_GIT_BLOCK = "Subagents cannot commit or push; report the change to the parent, which owns local commits and may push only with Alan's explicit authorization.";

async function validateGit(command: string, projectRoot: string, workdir: string, isChild: boolean, allowGitIndexFile = false): Promise<void> {
	const retargets = [...command.matchAll(/\b(?:export\s+)?(GIT_[A-Z0-9_]*)(\+?=)/g)];
	if (retargets.some((match) => !allowGitIndexFile || match[1] !== "GIT_INDEX_FILE" || match[2] !== "=") && /\bgit\b/.test(command)) {
		throw new Error("Blocked direct Git invocation with GIT_* environment retargeting");
	}
	const commands = tokenizeShell(command);
	if (!commands) { if (/\bgit\b/.test(command)) throw new Error("Blocked ambiguous direct Git invocation; shell syntax cannot be validated"); return; }
	let changedDirectory = false;
	for (const shellCommand of commands) {
		let index = 0; while (isAssignment(shellCommand[index])) index += 1;
		if (shellCommand[index] === "cd") { changedDirectory = true; continue; }
		const tokens = directGit(shellCommand, allowGitIndexFile); if (!tokens) continue;
		if (tokens.includes("--no-verify")) throw new Error("Blocked direct Git invocation containing --no-verify");
		const invocation = parseGit(tokens, workdir);
		if (!invocation) { if (isChild) throw new Error(SUBAGENT_GIT_BLOCK); continue; }
		if (isChild && (invocation.name === "commit" || invocation.name === "push")) throw new Error(SUBAGENT_GIT_BLOCK);
		if (invocation.name === "commit" && hasCommitNoVerify(invocation.args)) throw new Error("Blocked direct Git commit containing -n (short for --no-verify)");
		if (invocation.name === "push") validatePush(invocation.args);
		if (invocation.name === "worktree" && invocation.args[0] === "add") {
			if (changedDirectory) throw new Error("Blocked direct git worktree add after cd; set the Bash workdir explicitly");
			await validateWorktree(invocation.args.slice(1), projectRoot, invocation.workdir);
		}
	}
}

function normalize(command: string): string { return command.replace(ALLOW_INFRA_RETRY_RE, "").trim().replace(/\s+/g, " "); }
function resultText(event: ToolResultEvent): string { return event.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"); }

export function registerGuardrails(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>> = process.env): void {
	const isChild = isSubagentChildEnvironment(env);
	const infrastructureFailures = new Map<string, string>();
	const verificationCalls = new Set<string>();
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (event.toolName === "verification_evidence") {
			verificationCalls.add(event.toolCallId);
			return;
		}
		if (event.toolName === "subagent") {
			await validateBoundedReview(event.input);
			return;
		}
		if (event.toolName !== "bash" || !isRecord(event.input) || typeof event.input.command !== "string") return;
		const command = event.input.command;
		const allowGitIndexFile = event.parentToolCallId !== undefined
			&& verificationCalls.has(event.parentToolCallId)
			&& isVerificationIndexCommand(command);
		await validateGit(command, ctx.cwd, ctx.cwd, isChild, allowGitIndexFile);
		const normalized = normalize(command);
		const blocker = infrastructureFailures.get(normalized);
		if (blocker && !ALLOW_INFRA_RETRY_RE.test(command)) throw new Error(`Blocked repeat bash command after an unchanged DB/infrastructure failure in this session: ${normalized}\nPrevious blocker: ${blocker}\nIf the dependency state changed and you need one explicit retry, prefix the command with PI_ALLOW_INFRA_RETRY=1.`);
	});
	pi.on("tool_result", (event: ToolResultEvent) => {
		if (event.toolName === "verification_evidence") {
			verificationCalls.delete(event.toolCallId);
			return;
		}
		if (event.toolName !== "bash" || !isRecord(event.input) || typeof event.input.command !== "string" || !TEST_COMMAND_RE.test(event.input.command)) return;
		const normalized = normalize(event.input.command);
		const text = resultText(event);
		if (!DB_BLOCKER_RE.test(text)) infrastructureFailures.delete(normalized);
		else infrastructureFailures.set(normalized, text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "unknown blocker");
	});
}

export default registerGuardrails;
