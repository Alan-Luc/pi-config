import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const sourceDirs = ["agents", "extensions", "prompts", "skills"];

function markdownFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdownFiles(resolve(directory, entry.name));
		return entry.isFile() && entry.name.endsWith(".md") ? [resolve(directory, entry.name)] : [];
	});
}

const documents = [resolve(root, "AGENTS.md"), resolve(root, "README.md"), ...sourceDirs.flatMap((dir) => markdownFiles(resolve(root, dir)))];
const agentNames = new Set(readdirSync(resolve(root, "agents")).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)));
const repositoryPaths = documents.map((file) => file.replace(`${root}/`, ""));

type Reference = { source: string; target: string; line: number };
type Report = { broken: Reference[]; dynamic: Reference[]; runtime: Reference[]; illustrative: Reference[]; commands: Reference[] };

function dynamicPath(target: string): boolean {
	return /(?:\$\{|<[^>]+>|\*|\.\.\.|\{[^}]+\})/.test(target);
}

function runtimePath(target: string): boolean {
	return /^(?:~\/\.pi\/agent|\.harness\/$|\.harness\/(?:plans|live-verification|YYYY\/)|\/tmp\/|\/var\/tmp\/|node:os\.tmpdir\(\)|\$TMPDIR(?:\/|$))/.test(target);
}

function illustrativePath(target: string): boolean {
	return /^(?:alan\/ENG-|test_reports\/|specs\/|compose test |\/skill:|How to observe\/|references\/bugbot-triage\.md$)/.test(target)
		|| /^(?:cursor-team-kit|thermos|poteto-mode)\//.test(target);
}

function inspectReferences(files: string[], repositoryRoot: string): Report {
	const report: Report = { broken: [], dynamic: [], runtime: [], illustrative: [], commands: [] };
	for (const source of files) inspectMarkdownReferences(source, readFileSync(source, "utf8"), repositoryRoot, report);
	return report;
}

function inspectMarkdownReferences(source: string, text: string, repositoryRoot: string, report: Report): void {
	const lines = text.split(/\r?\n/);
	for (const [lineIndex, line] of lines.entries()) {
		for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
			const target = match[1].split("#", 1)[0];
			if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#")) continue;
			if (!existsSync(resolve(dirname(source), target))) report.broken.push({ source: source.replace(`${repositoryRoot}/`, ""), target, line: lineIndex + 1 });
		}
		for (const match of line.matchAll(/`([^`\n]+)`/g)) {
			const target = match[1].trim();
			if (!looksLikePath(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
			checkPath(target, source, dirname(source), lineIndex + 1, repositoryRoot, report);
		}
	}
}

function looksLikePath(value: string): boolean {
	return value.includes("/") || /\.(?:md|ts|tsx|js|mjs|json|sh|py|yaml|yml|toml|txt|html)$/.test(value);
}

function checkPath(target: string, source: string, base: string, line: number, repositoryRoot: string, report: Report): void {
	const reference = { source: source.replace(`${repositoryRoot}/`, ""), target, line };
	if (dynamicPath(target)) {
		report.dynamic.push(reference);
		return;
	}
	if (runtimePath(target) || (reference.source === "agents/config/README.md" && target === "mcp.json")) {
		report.runtime.push(reference);
		return;
	}
	if (/^\/[a-z][a-z0-9-]*$/.test(target)) {
		report.commands.push(reference);
		return;
	}
	if (illustrativePath(target)) {
		report.illustrative.push(reference);
		return;
	}
	const sourcePath = resolve(base, target);
	const rootPath = resolve(repositoryRoot, target);
	const knownRepoPath = !target.includes("/") && repositoryPaths.filter((path) => path.endsWith(`/${target}`)).length === 1;
	if (!existsSync(sourcePath) && !existsSync(rootPath) && !knownRepoPath) report.broken.push(reference);
}

function missingPromptAgents(files: string[], knownAgents: Set<string>, base: string): Reference[] {
	return files.filter((file) => file.includes(`${base}/prompts/`)).flatMap((source) =>
		findMissingAgents(source, readFileSync(source, "utf8"), knownAgents, base),
	);
}

function findMissingAgents(source: string, text: string, knownAgents: Set<string>, base: string): Reference[] {
	return text.split(/\r?\n/).flatMap((line, lineIndex) =>
		[...line.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)]
			.map((match) => match[1])
			.filter((name) => /(?:reviewer|engineer|explorer|verifier|babysitter|agent)(?:-|$)/.test(name) && !knownAgents.has(name))
			.map((name) => ({ source: source.replace(`${base}/`, ""), target: `agents/${name}.md`, line: lineIndex + 1 })),
	);
}

function format(references: Reference[]): string {
	return references.map(({ source, target, line }) => `${source}:${line} -> ${target}`).join("\n");
}

test("markdown links and repository paths resolve with explicit dynamic and runtime categories", () => {
	const report = inspectReferences(documents, root);
	const missingAgents = missingPromptAgents(documents, agentNames, root);
	assert.deepEqual(report.broken, [], format(report.broken));
	assert.deepEqual(missingAgents, [], format(missingAgents));
	console.info(`Dynamic paths: ${format(report.dynamic)}\nRuntime paths: ${format(report.runtime)}\nIllustrative paths: ${format(report.illustrative)}\nSlash commands: ${format(report.commands)}`);
});

test("reference checks reject broken links, missing paths, and missing prompt agents", () => {
	const fixtureRoot = resolve(root, "tests/fixtures/instruction-integrity");
	const source = resolve(fixtureRoot, "prompts/sample.md");
	const fixtureAgents = new Set(["code-reviewer"]);
	const report: Report = { broken: [], dynamic: [], runtime: [], illustrative: [], commands: [] };
	inspectMarkdownReferences(source, "[bad link](../missing.md) and `../missing.ts` and [wrong base](agents/code-reviewer.md)", fixtureRoot, report);
	assert.deepEqual(report.broken.map(({ target }) => target).sort(), ["../missing.md", "../missing.ts", "agents/code-reviewer.md"]);
	assert.deepEqual(findMissingAgents(source, "Use `missing-agent` with `code-reviewer`.", fixtureAgents, fixtureRoot).map(({ target }) => target), ["agents/missing-agent.md"]);
	const rephrased = "A reworded instruction has no repository references.";
	const clean: Report = { broken: [], dynamic: [], runtime: [], illustrative: [], commands: [] };
	inspectMarkdownReferences(resolve(fixtureRoot, "prompts/rephrased.md"), rephrased, fixtureRoot, clean);
	inspectMarkdownReferences(resolve(fixtureRoot, "agents/config/README.md"), "The initializer writes `mcp.json`; inspect `.harness/` when available.", fixtureRoot, clean);
	inspectMarkdownReferences(source, "Run `/publication-config`.", fixtureRoot, clean);
	assert.deepEqual(clean.broken, []);
	assert.deepEqual(clean.commands.map(({ target }) => target), ["/publication-config"]);
	assert.deepEqual(clean.runtime.map(({ target }) => target), ["mcp.json", ".harness/"]);
	assert.deepEqual(findMissingAgents(resolve(fixtureRoot, "prompts/rephrased.md"), rephrased, fixtureAgents, fixtureRoot), []);
});
