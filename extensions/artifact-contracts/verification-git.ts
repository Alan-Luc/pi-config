import { basename, resolve, sep } from "node:path";

const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree"]);
type ShellCommand = string[];

function hasParentTraversal(value: string): boolean {
	return value.split(sep === "\\" ? /[\\/]/ : "/").includes("..");
}

function hasAmbiguousExpansion(value: string): boolean {
	return /[$`*?\[\]{}~]/.test(value);
}

function isAssignment(value: string | undefined): boolean { return Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(value)); }
function isGit(value: string | undefined): boolean { return value === "git" || Boolean(value && /(?:^|\/)git$/.test(value)); }

function directGit(command: ShellCommand, allowGitIndexFile: boolean, workdir: string): string[] | undefined {
	let index = 0;
	while (isAssignment(command[index])) {
		const retarget = command[index].match(/^(GIT_[A-Z0-9_]*)(\+?=)/);
		if (retarget && (!allowGitIndexFile || retarget[1] !== "GIT_INDEX_FILE" || retarget[2] !== "=")) {
			throw new Error("Blocked direct Git invocation with GIT_* environment retargeting");
		}
		index += 1;
	}
	while (["builtin", "command", "exec"].includes(basename(command[index] ?? ""))) {
		const wrapper = basename(command[index++]);
		while (command[index]?.startsWith("-")) {
			const option = command[index++];
			if (option === "--") break;
			if (wrapper === "builtin") return undefined;
			if (wrapper === "command") {
				if (!/^-[pvV]+$/.test(option) || /[vV]/.test(option)) return undefined;
			} else {
				const nameOption = option.indexOf("a");
				const flags = nameOption < 0 ? option.slice(1) : option.slice(1, nameOption);
				if (option === "-" || !/^[cl]*$/.test(flags)) return undefined;
				if (nameOption >= 0 && nameOption === option.length - 1) {
					if (command[index] === undefined) return undefined;
					index += 1;
				}
			}
		}
	}
	const invocationTokens = command.slice(index);
	if (isGit(invocationTokens[0])) return invocationTokens;
	for (let offset = 0; offset < invocationTokens.length; offset += 1) {
		if (!isGit(invocationTokens[offset])) continue;
		const tokens = invocationTokens.slice(offset);
		const invocation = parseGit(tokens, workdir);
		if (invocation?.name === "push" || invocation?.name === "commit") return tokens;
	}
	return undefined;
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

export function rejectGitMutations(argv: readonly string[], workdir: string): void {
	const tokens = directGit([...argv], false, workdir);
	const invocation = tokens ? parseGit(tokens, workdir) : undefined;
	if (invocation?.name === "commit" || invocation?.name === "push"
		|| (invocation?.name === "worktree" && invocation.args[0] === "add")) {
		throw new Error("Blocked direct Git mutation: verification_evidence is check-only");
	}
}
