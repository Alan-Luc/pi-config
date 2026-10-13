import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, mock, test } from "bun:test";

type WorkLogModule = typeof import("../extensions/work-log/index.ts");
type WorkLogParams = import("../extensions/work-log/index.ts").WorkLogParams;
let registerWorkLog: WorkLogModule["default"];
let appendWorkLog: WorkLogModule["appendWorkLog"];

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
type LogContext = Parameters<WorkLogModule["appendWorkLog"]>[1];
const mutationQueue = async <T>(_path: string, operation: () => Promise<T>): Promise<T> => operation();

function append(params: WorkLogParams, ctx: LogContext) {
	return appendWorkLog(params, ctx, mutationQueue);
}

function tempDir(): string {
	return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pi-work-log-"));
}

function gitInit(path: string): void {
	execFileSync("git", ["init", path], { stdio: "ignore" });
}

function context(cwd: string, name = "Fixture session"): LogContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionName: () => name,
		},
	};
}

function work(overrides: Partial<Extract<WorkLogParams, { kind: "work" }>> = {}): Extract<WorkLogParams, { kind: "work" }> {
	return {
		kind: "work",
		title: "Implement logging",
		goal: "Replace the old logger",
		result: "Native logging works",
		completedWork: ["Added the extension"],
		changedPaths: ["extensions/work-log/index.ts"],
		checks: ["Focused tests pass"],
		blockers: ["None"],
		nextState: "Complete",
		plan: ".harness/plans/example.md",
		...overrides,
	};
}

function decision(): Extract<WorkLogParams, { kind: "decision" }> {
	return {
		kind: "decision",
		title: "Use live context",
		summary: "Use live Pi context for logging",
		approach: ["Read cwd and session metadata from the extension context"],
		rationale: "The runtime already owns those values.",
	};
}

function datePathParts(): { year: string; month: string; day: string } {
	const now = new Date();
	return {
		year: String(now.getFullYear()).padStart(4, "0"),
		month: String(now.getMonth() + 1).padStart(2, "0"),
		day: String(now.getDate()).padStart(2, "0"),
	};
}

function dailyPath(root: string, legacy = false): string {
	const { year, month, day } = datePathParts();
	return join(root, legacy ? ".opencode" : ".harness", year, month, `${day}.md`);
}

async function loadPiApi() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	assert.ok(installRoot, "PI_MANAGED_INSTALL_ROOT is required for registered-tool coverage");
	const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
	return import(join(installRoot, "releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
}

beforeAll(async () => {
	const piApi = await loadPiApi();
	mock.module("@earendil-works/pi-coding-agent", () => piApi);
	const workLog = await import("../extensions/work-log/index.ts");
	registerWorkLog = workLog.default;
	appendWorkLog = workLog.appendWorkLog;
});

afterAll(() => mock.restore());

async function registeredWorkLog(root: string) {
	const { DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } = await loadPiApi();
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: resolve(import.meta.dir, ".."),
		settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		root,
		SessionManager.inMemory(root),
		new ModelRegistry(modelRuntime),
	);
	const tool = runner.getToolDefinition("work_log");
	assert.ok(tool);
	return { runner, tool };
}

async function withProject(run: (root: string) => Promise<void>, git = true): Promise<void> {
	const root = tempDir();
	try {
		if (git) gitInit(root);
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("registers one typed work_log tool", () => {
	assert.equal(typeof registerWorkLog, "function");
	assert.match(registerWorkLog.toString(), /registerTool/);
});

test("serializes concurrent calls through the registered tool and native queue", async () => {
	await withProject(async (root) => {
		const { runner, tool } = await registeredWorkLog(root);
		assert.equal(tool.annotations?.openWorldHint, false);
		const execute = (id: string) =>
			tool.execute(id, work(), undefined, undefined, runner.createToolContext(id, undefined));
		const results = await Promise.all([execute("first"), execute("second")]);
		const texts = results.map((result) => {
			const [content] = result.content;
			if (!content || content.type !== "text") throw new Error("work_log returned non-text content");
			return content.text;
		});
		assert.equal(texts.filter((text) => text.startsWith("Appended work entry")).length, 1);
		assert.equal(texts.filter((text) => text.startsWith("Skipped duplicate work entry")).length, 1);
		const content = readFileSync(dailyPath(root), "utf8");
		assert.equal((content.match(/## .* — Implement logging/g) ?? []).length, 1);
	});
});

test("appends a work entry with the canonical heading and repo-relative result path", async () => {
	await withProject(async (root) => {
		const result = await append(work(), context(root));
		const path = dailyPath(root);
		const content = readFileSync(path, "utf8");
		assert.match(content, /^# Work log — \d{4}-\d{2}-\d{2}\n/);
		assert.match(content, /## \d{4}-\d{2}-\d{2} — Implement logging/);
		assert.match(content, /\*\*Goal:\*\* Replace the old logger/);
		assert.match(content, /\*\*Result:\*\* Native logging works/);
		assert.match(content, /\*\*Completed work:\*\*/);
		assert.match(content, /\*\*Changed paths \/ artifacts:\*\*/);
		assert.match(content, /\*\*Checks:\*\*/);
		assert.match(content, /\*\*Blockers:\*\*/);
		assert.match(content, /\*\*Next state:\*\* Complete/);
		assert.match(content, /\*\*Plan:\*\* \.harness\/plans\/example\.md/);
		assert.match(content, /\*\*Handoff:\*\* None — no human action required/);
		assert.equal(result.details.path, ".harness/" + path.split("/.harness/")[1]);
		assert.equal(result.details.duplicate, false);
	});
});

test("appends decision entries with live session id and name", async () => {
	await withProject(async (root) => {
		await append(decision(), context(root, "Session `name`\nwith spaces"));
		const content = readFileSync(dailyPath(root), "utf8");
		assert.match(content, /\*\*Session:\*\* `11111111-1111-4111-8111-111111111111` \(Session 'name' with spaces\)/);
		assert.match(content, /\*\*Summary:\*\* Use live Pi context for logging/);
		assert.match(content, /\*\*Approach:\*\*/);
		assert.match(content, /\*\*Rationale:\*\* The runtime already owns those values\./);
	});
});

test("preserves append order and only writes one daily heading", async () => {
	await withProject(async (root) => {
		await append(work({ title: "First", result: "First result" }), context(root));
		await append(work({ title: "Second", result: "Second result" }), context(root));
		const content = readFileSync(dailyPath(root), "utf8");
		assert.equal((content.match(/^# Work log/gm) ?? []).length, 1);
		assert.ok(content.indexOf("First result") < content.indexOf("Second result"));
	});
});

test("skips duplicates in canonical and legacy logs without creating or changing the target", async () => {
	await withProject(async (root) => {
		const first = await append(work(), context(root));
		const canonical = dailyPath(root);
		const before = readFileSync(canonical, "utf8");
		const duplicate = await append(work(), context(root));
		assert.equal(duplicate.details.duplicate, true);
		assert.equal(duplicate.details.existingPath, ".harness/" + canonical.split("/.harness/")[1]);
		assert.equal(readFileSync(canonical, "utf8"), before);
		assert.equal(first.details.duplicate, false);
	});

	await withProject(async (root) => {
		const legacy = dailyPath(root, true);
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, "# Work log — 2026-10-02\n\n", "utf8");
		const source = await append(work({ title: "Legacy duplicate" }), context(root));
		const canonical = dailyPath(root);
		const legacyContent = readFileSync(legacy, "utf8") + readFileSync(canonical, "utf8").split("\n\n").slice(1).join("\n\n");
		writeFileSync(legacy, legacyContent, "utf8");
		rmSync(canonical);
		const duplicate = await append(work({ title: "Legacy duplicate" }), context(root));
		assert.equal(duplicate.details.duplicate, true);
		assert.equal(duplicate.details.existingPath, ".opencode/" + legacy.split("/.opencode/")[1]);
		assert.equal(readFileSync(legacy, "utf8"), legacyContent);
		assert.equal(source.details.path, ".harness/" + canonical.split("/.harness/")[1]);
	});
});

test("sanitizes whitespace and backticks in fields", async () => {
	await withProject(async (root) => {
		await append(
			work({ title: "  `Title`\nwith   spaces  ", goal: " `goal`\nvalue ", decisions: [" `material`\nchoice "] }),
			context(root, " `Session`\nname "),
		);
		const content = readFileSync(dailyPath(root), "utf8");
		assert.ok(content.includes("## "));
		assert.ok(content.includes("'Title' with spaces"));
		assert.ok(content.includes("'goal' value"));
		assert.ok(content.includes("'material' choice"));
		assert.ok(content.includes("('Session' name)"));
		assert.ok(!content.includes("`Title`"));
	});
});

test("uses a nested Git root and ignores ambient Git variables", async () => {
	await withProject(async (outer) => {
		const nested = join(outer, "nested");
		mkdirSync(nested);
		gitInit(nested);
		await append(work({ title: "Nested", result: "Nested root" }), context(nested));
		assert.ok(readFileSync(dailyPath(nested), "utf8").includes("Nested root"));
		assert.equal(requirePath(dailyPath(outer)), false);
	}, true);

	await withProject(async (root) => {
		const foreign = join(root, "foreign");
		const project = join(root, "project");
		mkdirSync(foreign);
		mkdirSync(project);
		gitInit(foreign);
		const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = join(foreign, ".git");
		process.env.GIT_WORK_TREE = foreign;
		try {
			await append(work({ title: "Ambient", result: "Ambient ignored" }), context(project));
		} finally {
			if (previous.GIT_DIR === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = previous.GIT_DIR;
			if (previous.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE;
			else process.env.GIT_WORK_TREE = previous.GIT_WORK_TREE;
		}
		assert.ok(readFileSync(dailyPath(project), "utf8").includes("Ambient ignored"));
		assert.equal(requirePath(dailyPath(foreign)), false);
	}, false);
});

test("falls back to a verified non-Git cwd", async () => {
	await withProject(async (root) => {
		await append(work({ title: "Non-Git", result: "Fallback works" }), context(root));
		assert.ok(readFileSync(dailyPath(root), "utf8").includes("Fallback works"));
	}, false);
});

test("does not fall back from corrupt Git metadata", async () => {
	await withProject(async (root) => {
		mkdirSync(join(root, ".git"));
		await assert.rejects(() => append(work(), context(root)), /Git root lookup failed.*not a git repository/);
		assert.equal(requirePath(join(root, ".harness")), false);
	}, false);
});

test("fails descriptively when Git is unavailable", async () => {
	await withProject(async (root) => {
		const previousPath = process.env.PATH;
		process.env.PATH = join(root, "missing-bin");
		try {
			await assert.rejects(() => append(work(), context(root)), /Cannot invoke Git.*Executable not found/);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		assert.equal(requirePath(join(root, ".harness")), false);
	});
});

test("rejects a Git root outside ctx.cwd ancestry", async () => {
	const root = tempDir();
	const outside = tempDir();
	const bin = tempDir();
	const previousPath = process.env.PATH;
	try {
		const fakeGit = join(bin, "git");
		writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(realpathSync(outside))}\n`, "utf8");
		chmodSync(fakeGit, 0o755);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		await assert.rejects(() => append(work(), context(root)), /Git root is outside ctx\.cwd ancestry/);
		assert.equal(requirePath(join(outside, ".harness")), false);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("rejects missing and file cwds before creating logs", async () => {
	const root = tempDir();
	try {
		const file = join(root, "file");
		writeFileSync(file, "fixture", "utf8");
		await assert.rejects(() => append(work(), context(join(root, "missing"))), /ctx\.cwd/);
		await assert.rejects(() => append(work(), context(file)), /ctx\.cwd/);
		assert.deepEqual(requirePath(join(root, ".harness")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	["root", (root: string, outside: string) => {
		const { year, month, day } = datePathParts();
		symlinkSync(outside, join(root, ".harness"));
		return join(outside, year, month, `${day}.md`);
	}],
	["intermediate", (root: string, outside: string) => {
		const { year, month, day } = datePathParts();
		const outsideYear = join(outside, year);
		mkdirSync(outsideYear);
		mkdirSync(join(root, ".harness"));
		symlinkSync(outsideYear, join(root, ".harness", year));
		return join(outsideYear, month, `${day}.md`);
	}],
	["destination", (root: string, outside: string) => {
		const destination = dailyPath(root);
		const escaped = join(outside, "escaped.md");
		mkdirSync(join(destination, ".."), { recursive: true });
		symlinkSync(escaped, destination);
		return escaped;
	}],
] as const)("rejects a symlinked %s without writing outside the repo", async (_kind, setup) => {
	const root = tempDir();
	const outside = tempDir();
	try {
		gitInit(root);
		const escapedPath = setup(root, outside);
		await assert.rejects(() => append(work(), context(root)), /symlink/);
		assert.equal(requirePath(escapedPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("uses only live Pi context for session metadata", () => {
	const source = readFileSync(new URL("../extensions/work-log/index.ts", import.meta.url), "utf8");
	const staleNames = [
		["JSON", "L"].join(""),
		["session", "_inspect"].join(""),
		["PI_CODING_AGENT_", "SESSION_DIR"].join(""),
		["append", "_work_log.py"].join(""),
	];
	assert.equal(staleNames.some((name) => source.includes(name)), false);
});

test("work-log policy records milestones without logging trivial direct work", () => {
	const common = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
	assert.match(common, /Truly trivial direct work is the exact action plus a direct check: no plan, task list, work log, review, handoff/);
	assert.match(common, /work logs record material milestones, decisions, blockers, interruptions, and next state/);
});

function requirePath(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}
