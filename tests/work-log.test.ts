import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function context(cwd: string, name = "Fixture session", authorizeRecovery?: (path: string, token: string) => Promise<boolean>): LogContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionName: () => name,
		},
		...(authorizeRecovery ? { authorizeRecovery } : {}),
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
		plan: ".harness/plans/2026-10-24-example.md",
		...overrides,
	};
}

function decision(overrides: Partial<Extract<WorkLogParams, { kind: "decision" }>> = {}): Extract<WorkLogParams, { kind: "decision" }> {
	return {
		kind: "decision",
		title: "Use live context",
		summary: "Use live Pi context for logging",
		approach: ["Read cwd and session metadata from the extension context"],
		rationale: "The runtime already owns those values.",
		plan: ".harness/plans/2026-10-24-example.md",
		...overrides,
	};
}

function setupPlan(root: string): void {
	const path = join(root, ".harness/plans/2026-10-24-example.md");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "# Example plan\\n", "utf8");
}

function topicPath(root: string, key = "2026-10-24-example"): string {
	const { year, month, day } = datePathParts();
	return join(root, ".harness", year, month, day, `${key}.md`);
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
		setupPlan(root);
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("registers one typed work_log tool", () => {
	assert.equal(typeof registerWorkLog, "function");
	assert.match(registerWorkLog.toString(), /registerTool/);
});

test("exposes a top-level object schema to strict model providers", () => {
	let tool: { parameters: { type?: string } } | undefined;
	registerWorkLog({ registerTool: (definition: NonNullable<typeof tool>) => { tool = definition; } } as never);
	assert.equal(tool?.parameters.type, "object");
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
		const content = readFileSync(topicPath(root), "utf8");
		assert.equal((content.match(/## .* — Implement logging/g) ?? []).length, 1);
	});
});

test("appends a work entry with the canonical heading and repo-relative result path", async () => {
	await withProject(async (root) => {
		const result = await append(work(), context(root));
		const path = topicPath(root);
		const content = readFileSync(path, "utf8");
		assert.match(content, /^# Work log — \d{4}-\d{2}-\d{2} — 2026-10-24-example\n/);
		assert.match(content, /## \d{4}-\d{2}-\d{2} — Implement logging/);
		assert.match(content, /\*\*Goal:\*\* Replace the old logger/);
		assert.match(content, /\*\*Result:\*\* Native logging works/);
		assert.match(content, /\*\*Completed work:\*\*/);
		assert.match(content, /\*\*Changed paths \/ artifacts:\*\*/);
		assert.match(content, /\*\*Checks:\*\*/);
		assert.match(content, /\*\*Blockers:\*\*/);
		assert.match(content, /\*\*Next state:\*\* Complete/);
		assert.match(content, /\*\*Plan:\*\* \.harness\/plans\/2026-10-24-example\.md/);
		assert.match(content, /\*\*Handoff:\*\* None — no human action required/);
		assert.equal(result.details.path, ".harness/" + path.split("/.harness/")[1]);
		assert.equal(result.details.duplicate, false);
	});
});

test("routes work and decisions to separate plan topics and supports explicit no-plan features", async () => {
	await withProject(async (root) => {
		await append(work(), context(root));
		await append(decision(), context(root));
		const workLog = readFileSync(topicPath(root), "utf8");
		assert.ok(workLog.includes("**Plan:** .harness/plans/2026-10-24-example.md"));
		assert.match(workLog, /Use live Pi context for logging/);
		assert.equal((workLog.match(/^# Work log/gm) ?? []).length, 1);
		const feature = await append(work({ plan: "None", topic: "local-feature", title: "No-plan feature" }), context(root));
		assert.equal(feature.details.path, ".harness/" + topicPath(root, "local-feature").split("/.harness/")[1]);
		assert.ok(readFileSync(topicPath(root, "local-feature"), "utf8").includes("**Plan:** None"));
	});
});

test("renders only finite nonnegative completion metrics on work entries", async () => {
	await withProject(async (root) => {
		await append(work({ metrics: { activeSeconds: 12.5, pausedSeconds: 0, passSeconds: 30, children: 2 } }), context(root));
		const content = readFileSync(topicPath(root), "utf8");
		assert.ok(content.includes("**Completion metrics:**\n- activeSeconds: 12.5\n- pausedSeconds: 0\n- passSeconds: 30\n- children: 2"));
		await assert.rejects(() => append(work({ title: "Invalid metrics", metrics: { activeSeconds: Number.NaN } }), context(root)), /finite nonnegative/);
		await assert.rejects(() => append(work({ title: "Fractional children", metrics: { children: 1.5 } }), context(root)), /integer/);
		const extraMetric = Object.assign({ activeSeconds: 1 }, { futureMetric: 123 });
		await append(work({ title: "Unknown metric", metrics: extraMetric }), context(root));
		assert.ok(!readFileSync(topicPath(root), "utf8").includes("futureMetric"));
		assert.equal(requirePath(topicPath(root)), true);
	});
});

test.each([
	["missing plan", { plan: ".harness/plans/2026-10-24-missing.md" }],
	["noncanonical plan", { plan: ".harness/plans/example.md" }],
	["invalid calendar date", { plan: ".harness/plans/2026-02-30-invalid.md" }],
	["conflicting topic", { topic: "other-topic" }],
	["missing feature topic", { plan: "None" }],
	["unsafe feature topic", { plan: "None", topic: "../escape" }],
	["date-prefixed feature topic", { plan: "None", topic: "2026-10-24-feature" }],
	["non-lowercase feature topic", { plan: "None", topic: "Local-Feature" }],
] as const)("rejects %s before creating the topic log", async (_label, override) => {
	await withProject(async (root) => {
		await assert.rejects(() => append(work(override), context(root)), /plan|topic|slug/);
		assert.equal(requirePath(topicPath(root)), false);
	});
});

test("rejects a symlinked plan before creating a topic log", async () => {
	await withProject(async (root) => {
		const outside = tempDir();
		try {
			const plan = join(root, ".harness/plans/2026-10-24-example.md");
			const outsidePlan = join(outside, "plan.md");
			writeFileSync(outsidePlan, "# Outside\\n", "utf8");
			rmSync(plan);
			symlinkSync(outsidePlan, plan);
			await assert.rejects(() => append(work(), context(root)), /symlink/);
			assert.equal(requirePath(topicPath(root)), false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

test("no-plan decisions use the same explicit feature topic as work", async () => {
	await withProject(async (root) => {
		const params = { ...decision({ plan: "None" }), topic: "local-feature" };
		await append(work({ plan: "None", topic: "local-feature" }), context(root));
		const result = await append(params, context(root));
		assert.equal(result.details.path, ".harness/" + topicPath(root, "local-feature").split("/.harness/")[1]);
		const content = readFileSync(topicPath(root, "local-feature"), "utf8");
		assert.match(content, /Use live Pi context for logging/);
		assert.equal((content.match(/^# Work log/gm) ?? []).length, 1);
	});
});

test.each(["feature-one", "feature-two"])("legacy no-plan records cannot suppress an unidentifiable feature topic: %s", async (topic) => {
	await withProject(async (root) => {
		const legacy = dailyPath(root);
		mkdirSync(dirname(legacy), { recursive: true });
		const before = `# Work log\n\n## 2026-10-24 — Implement logging\n\n**Session:** \`${SESSION_ID}\`\n\n**Result:** Native logging works\n\n**Plan:** None\n`;
		writeFileSync(legacy, before);
		const result = await append(work({ plan: "None", topic }), context(root));
		assert.equal(result.details.duplicate, false, "legacy None did not identify this feature");
		assert.equal(result.details.path, ".harness/" + topicPath(root, topic).split("/.harness/")[1]);
		assert.equal(readFileSync(legacy, "utf8"), before);
	});
});

test("no-plan decisions require an explicit feature topic", async () => {
	await withProject(async (root) => {
		await assert.rejects(() => append(decision({ plan: "None" }), context(root)), /supply topic/);
		assert.equal(requirePath(topicPath(root)), false);
	});
});

test("an unscoped legacy no-plan decision cannot suppress a feature decision", async () => {
	await withProject(async (root) => {
		const legacy = dailyPath(root);
		mkdirSync(dirname(legacy), { recursive: true });
		const { year, month, day } = datePathParts();
		const iso = `${year}-${month}-${day}`;
		const before = `# Work log\n\n## ${iso} — Use live context\n\n**Session:** \`${SESSION_ID}\`\n\n**Summary:** Use live Pi context for logging\n\n**Plan:** None\n`;
		writeFileSync(legacy, before);
		const result = await append(decision({ plan: "None", topic: "local-feature" }), context(root));
		assert.equal(result.details.duplicate, false);
		assert.equal(result.details.path, ".harness/" + topicPath(root, "local-feature").split("/.harness/")[1]);
		assert.equal(readFileSync(legacy, "utf8"), before);
		assert.match(readFileSync(topicPath(root, "local-feature"), "utf8"), /\*\*Topic:\*\* local-feature/);
	});
});

test("appends decision entries with live session id and name", async () => {
	await withProject(async (root) => {
		await append(decision(), context(root, "Session `name`\nwith spaces"));
		const content = readFileSync(topicPath(root), "utf8");
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
		const content = readFileSync(topicPath(root), "utf8");
		assert.equal((content.match(/^# Work log/gm) ?? []).length, 1);
		assert.ok(content.indexOf("First result") < content.indexOf("Second result"));
	});
});

test("skips duplicates in canonical and legacy logs without creating or changing the target", async () => {
	await withProject(async (root) => {
		const first = await append(work(), context(root));
		const canonical = topicPath(root);
		const before = readFileSync(canonical, "utf8");
		const duplicate = await append(work(), context(root));
		assert.equal(duplicate.details.duplicate, true);
		assert.equal(duplicate.details.existingPath, ".harness/" + canonical.split("/.harness/")[1]);
		assert.equal(duplicate.details.path, duplicate.details.existingPath);
		assert.equal(readFileSync(canonical, "utf8"), before);
		assert.equal(first.details.duplicate, false);
	});

	await withProject(async (root) => {
		const legacy = dailyPath(root, true);
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, "# Work log — 2026-10-02\n\n", "utf8");
		const source = await append(work({ title: "Legacy duplicate" }), context(root));
		const canonical = topicPath(root);
		const legacyContent = readFileSync(legacy, "utf8") + readFileSync(canonical, "utf8").split("\n\n").slice(1).join("\n\n");
		writeFileSync(legacy, legacyContent, "utf8");
		rmSync(canonical);
		const duplicate = await append(work({ title: "Legacy duplicate" }), context(root));
		assert.equal(duplicate.details.duplicate, true);
		assert.equal(duplicate.details.existingPath, ".opencode/" + legacy.split("/.opencode/")[1]);
		assert.equal(duplicate.details.path, duplicate.details.existingPath);
		assert.equal(readFileSync(legacy, "utf8"), legacyContent);
		assert.equal(source.details.path, ".harness/" + canonical.split("/.harness/")[1]);
	});
});

test("same-topic independent processes append intact entries with one header", async () => {
	await withProject(async (root) => {
		const modulePath = new URL("../extensions/work-log/index.ts", import.meta.url).href;
		const script = `const { appendWorkLog } = await import(process.env.WORK_LOG_MODULE);\nconst id = process.env.WORK_LOG_SESSION;\nconst params = JSON.parse(process.env.WORK_LOG_PARAMS);\nawait appendWorkLog(params, { cwd: process.env.WORK_LOG_ROOT, sessionManager: { getSessionId: () => id, getSessionName: () => "child" } }, async (_path, operation) => operation());`;
		const write = (id: string) => new Promise<void>((resolveWrite, rejectWrite) => {
			const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], env: {
				...process.env,
				WORK_LOG_MODULE: modulePath,
				WORK_LOG_ROOT: root,
				WORK_LOG_SESSION: id,
				TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
				WORK_LOG_PARAMS: JSON.stringify(work({ title: `Process ${id}` })),
			} });
			let output = "";
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
			child.once("error", rejectWrite);
			child.once("close", (code) => code === 0 ? resolveWrite() : rejectWrite(new Error(`writer exited ${code}: ${output}`)));
		});
		await Promise.all(["session-one", "session-two", "session-three"].map(write));
		const content = readFileSync(topicPath(root), "utf8");
		assert.equal((content.match(/^# Work log/gm) ?? []).length, 1);
		for (const id of ["session-one", "session-two", "session-three"]) assert.ok(content.includes(`Process ${id}`));
	});
});

test("independent topics do not share a writer lock", async () => {
	await withProject(async (root) => {
		const lockPath = `${topicPath(root)}.lock`;
		mkdirSync(join(topicPath(root), ".."), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: 999, session: "held", createdAt: "now", token: "held-token" }));
		const result = await append(work({ plan: "None", topic: "independent-feature" }), context(root));
		assert.equal(result.details.path, ".harness/" + topicPath(root, "independent-feature").split("/.harness/")[1]);
		assert.equal(requirePath(lockPath), true);
	});
});

test("lock recovery requires the exact owner token and preserves foreign ownership", async () => {
	await withProject(async (root) => {
		const lockPath = `${topicPath(root)}.lock`;
		mkdirSync(join(topicPath(root), ".."), { recursive: true });
		const owner = { session: "crashed-session", createdAt: "2026-10-24T12:00:00.000Z", token: "owner-token" };
		const crashedWriter = spawn(process.execPath, ["-e", `require("node:fs").writeFileSync(process.env.WORK_LOG_LOCK, JSON.stringify({ pid: process.pid, ...JSON.parse(process.env.WORK_LOG_OWNER) })); process.exit(71);`], {
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, WORK_LOG_LOCK: lockPath, WORK_LOG_OWNER: JSON.stringify(owner) },
		});
		const crashExit = await new Promise<number | null>((resolveExit, rejectExit) => {
			crashedWriter.once("error", rejectExit);
			crashedWriter.once("close", resolveExit);
		});
		assert.equal(crashExit, 71);
		await assert.rejects(() => append(work(), context(root)), (error) =>
			error instanceof Error && error.message.includes(topicPath(root)) && error.message.includes("pid=")
				&& error.message.includes("session=crashed-session") && error.message.includes("created=2026-10-24T12:00:00.000Z")
				&& error.message.includes("token=owner-token"));
		await assert.rejects(() => append({ kind: "recover", plan: ".harness/plans/2026-10-24-example.md", expectedToken: owner.token }, context(root)), /explicit authorization/);
		await assert.rejects(() => append({ kind: "recover", plan: ".harness/plans/2026-10-24-example.md", expectedToken: "wrong-token" }, context(root, "Fixture session", async () => true)), /Nothing was removed/);
		await assert.rejects(() => append({ kind: "recover", plan: ".harness/plans/2026-10-24-example.md", expectedToken: `${owner.token}\n` }, context(root, "Fixture session", async () => true)), /expectedToken must exactly match/);
		assert.equal(requirePath(lockPath), true);
		await append({ kind: "recover", plan: ".harness/plans/2026-10-24-example.md", expectedToken: owner.token }, context(root, "Fixture session", async () => true));
		assert.equal(requirePath(lockPath), false);
		await append(work(), context(root));
		assert.ok(readFileSync(topicPath(root), "utf8").includes("Native logging works"));
	});
});

test("suppresses only a matching-plan legacy work duplicate and keeps its bytes unchanged", async () => {
	await withProject(async (root) => {
		const historical = dailyPath(root);
		mkdirSync(join(historical, ".."), { recursive: true });
		const { year, month, day } = datePathParts();
		const iso = `${year}-${month}-${day}`;
		const original = [
			`# Work log — ${iso}`,
			"",
			`## ${iso} — Implement logging`,
			"",
			`**Session:** \`${SESSION_ID}\``,
			"",
			"**Result:** Native logging works",
			"",
			"**Plan:** .harness/plans/2026-10-24-example.md",
		].join("\n");
		writeFileSync(historical, original, "utf8");
		const duplicate = await append(work(), context(root));
		assert.equal(duplicate.details.duplicate, true);
		assert.equal(duplicate.details.path, ".harness/" + historical.split("/.harness/")[1]);
		assert.equal(readFileSync(historical, "utf8"), original);
		assert.equal(requirePath(topicPath(root)), false);
	});
});

test("does not suppress different-plan work or unscoped legacy decisions", async () => {
	await withProject(async (root) => {
		const historical = dailyPath(root);
		mkdirSync(join(historical, ".."), { recursive: true });
		const otherPlan = ".harness/plans/2026-10-23-other.md";
		writeFileSync(join(root, otherPlan), "# Other plan\n", "utf8");
		const { year, month, day } = datePathParts();
		const iso = `${year}-${month}-${day}`;
		const original = [
			`# Work log — ${iso}`,
			"",
			`## ${iso} — Implement logging`,
			"",
			`**Session:** \`${SESSION_ID}\``,
			"",
			"**Result:** Native logging works",
			"",
			`**Plan:** ${otherPlan}`,
			"",
			`## ${iso} — Use live context`,
			"",
			`**Session:** \`${SESSION_ID}\``,
			"",
			"**Summary:** Use live Pi context for logging",
		].join("\n");
		writeFileSync(historical, original, "utf8");
		assert.equal((await append(work(), context(root))).details.duplicate, false);
		assert.equal((await append(decision(), context(root))).details.duplicate, false);
		assert.equal(readFileSync(historical, "utf8"), original);
	});
});

test("keeps historical daily log bytes unchanged while appending a topic", async () => {
	await withProject(async (root) => {
		const historical = dailyPath(root);
		mkdirSync(join(historical, ".."), { recursive: true });
		const original = "# Work log — 2026-10-23\\n\\nuntouched\\n";
		writeFileSync(historical, original, "utf8");
		await append(work(), context(root));
		assert.equal(readFileSync(historical, "utf8"), original);
	});
});

test("sanitizes whitespace and backticks in fields", async () => {
	await withProject(async (root) => {
		await append(
			work({ title: "  `Title`\nwith   spaces  ", goal: " `goal`\nvalue ", decisions: [" `material`\nchoice "] }),
			context(root, " `Session`\nname "),
		);
		const content = readFileSync(topicPath(root), "utf8");
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
		setupPlan(nested);
		await append(work({ title: "Nested", result: "Nested root" }), context(nested));
		assert.ok(readFileSync(topicPath(nested), "utf8").includes("Nested root"));
		assert.equal(requirePath(topicPath(outer)), false);
	}, true);

	await withProject(async (root) => {
		const foreign = join(root, "foreign");
		const project = join(root, "project");
		mkdirSync(foreign);
		mkdirSync(project);
		setupPlan(project);
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
		assert.ok(readFileSync(topicPath(project), "utf8").includes("Ambient ignored"));
		assert.equal(requirePath(topicPath(foreign)), false);
	}, false);
});

test("falls back to a verified non-Git cwd", async () => {
	await withProject(async (root) => {
		await append(work({ title: "Non-Git", result: "Fallback works" }), context(root));
		assert.ok(readFileSync(topicPath(root), "utf8").includes("Fallback works"));
	}, false);
});

test("does not fall back from corrupt Git metadata", async () => {
	await withProject(async (root) => {
		mkdirSync(join(root, ".git"));
		await assert.rejects(() => append(work(), context(root)), /Git root lookup failed.*not a git repository/);
		assert.equal(requirePath(topicPath(root)), false);
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
		assert.equal(requirePath(topicPath(root)), false);
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
		mkdirSync(join(root, ".harness"), { recursive: true });
		symlinkSync(outsideYear, join(root, ".harness", year));
		return join(outsideYear, month, `${day}.md`);
	}],
	["destination", (root: string, outside: string) => {
		const destination = topicPath(root);
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
		if (_kind !== "root") setupPlan(root);
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

test("work-log policy records milestones without logging Direct work", () => {
	const common = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
	assert.match(common, /\| Direct \| Mechanical\/docs, no behavior change or material trust\/persistence\/contract risk: direct consuming-surface check; no workflow ceremony/);
	assert.match(common, /For non-Direct work[\s\S]*Record each completed implementation, review, or configuration slice once through `work_log`, using its returned topic path/);
	assert.match(common, /logs own milestones, checks, decisions, blockers and next state/);
});

function requirePath(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}
