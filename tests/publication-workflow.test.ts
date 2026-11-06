import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import guardrails from "../extensions/guardrails/index.ts";
import { createPublicationRuntime, loadPublicationConfig } from "../extensions/guardrails/publication-runtime.ts";

const config = {
	enabled: true, instance: "https://gitlab.fixture", project: "group/project",
	pushUrl: "https://gitlab.fixture/group/project.git", branchPrefix: "alan/ENG-", actions: ["push"],
	maxCommits: 4, gitlabTokenEnv: "PUBLICATION_FIXTURE_TOKEN",
	scanner: { executable: "/owned/scanner", version: "fixture-1", configPath: "/owned/config", configSha256: "a".repeat(64), scannerId: "b".repeat(64) },
};
const events = { on: () => () => {}, emit: () => {} };

function fixture(child = false) {
	const root = mkdtempSync(join(tmpdir(), "publication-selection-"));
	const path = join(root, "grant.json");
	writeFileSync(path, JSON.stringify(config));
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notices: string[] = [];
	let input: string | undefined = path;
	const ctx = {
		cwd: root, hasUI: true,
		sessionManager: { getSessionId: () => "owner" },
		waitForIdle: async () => {},
		ui: { input: async () => input, notify: (message: string) => notices.push(message) },
	};
	const markers = ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"];
	const saved = markers.map((key) => ({ key, value: process.env[key] }));
	if (!child) for (const key of markers) delete process.env[key];
	try {
		guardrails({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); }, registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, command); }, events } as never);
	} finally {
		for (const { key, value } of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	const push = () => handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "attempt", input: { command: "git push origin alan/ENG-fixture" } }, ctx);
	return { root, path, ctx, notices, commands, handlers, push, setInput: (value: string | undefined) => { input = value; } };
}

test.each([
	[undefined, "PI_PUBLICATION_CONFIG_PATH is unset"],
	["/publication-fixture/missing.json", "publication configuration is unreadable"],
] as const)("explains configuration prerequisite %s", async (path, reason) => {
	await expect(loadPublicationConfig(path)).rejects.toThrow(reason);
});

test.each([
	["{", "publication configuration is not JSON"],
	[JSON.stringify({ enabled: false }), "publication configuration is disabled"],
	[JSON.stringify({ ...config, unexpected: true }), "publication configuration does not match the grant schema"],
] as const)("reports a safe reason for configuration %s", async (contents, reason) => {
	const root = mkdtempSync(join(tmpdir(), "publication-invalid-"));
	try {
		const path = join(root, "grant.json");
		writeFileSync(path, contents);
		await expect(loadPublicationConfig(path)).rejects.toThrow(reason);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["session_shutdown", "session_tree"])("native selection preserves external bytes and resets on %s", async (resetEvent) => {
	const previous = process.env.PI_PUBLICATION_CONFIG_PATH;
	delete process.env.PI_PUBLICATION_CONFIG_PATH;
	const f = fixture();
	const original = readFileSync(f.path, "utf8");
	try {
		expect(f.commands.has("publication-config")).toBe(true);
		await f.handlers.get("session_start")!({}, f.ctx);
		await expect(f.push()).rejects.toThrow("PI_PUBLICATION_CONFIG_PATH is unset");
		await f.commands.get("publication-config")!.handler("", f.ctx);
		expect(f.notices.at(-1)).toContain("selected for this session");
		expect(process.env.PI_PUBLICATION_CONFIG_PATH).toBeUndefined();
		await expect(f.push()).rejects.toThrow("Git state or trusted publication adapter unavailable");
		for (const input of [undefined, "relative.json", join(f.root, "absent")]) {
			f.setInput(input);
			await f.commands.get("publication-config")!.handler("", f.ctx);
			await expect(f.push()).rejects.toThrow("Git state or trusted publication adapter unavailable");
		}
		expect(readFileSync(f.path, "utf8")).toBe(original);
		await f.handlers.get(resetEvent)!({}, f.ctx);
		await expect(f.push()).rejects.toThrow("PI_PUBLICATION_CONFIG_PATH is unset");
	} finally {
		if (previous === undefined) delete process.env.PI_PUBLICATION_CONFIG_PATH;
		else process.env.PI_PUBLICATION_CONFIG_PATH = previous;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("native selection refuses missing UI and ignores command arguments", async () => {
	const f = fixture();
	try {
		expect(f.commands.has("publication-config")).toBe(true);
		await f.commands.get("publication-config")!.handler(f.path, { ...f.ctx, hasUI: false });
		expect(f.notices.at(-1)).toContain("native UI");
		f.setInput(undefined);
		await f.commands.get("publication-config")!.handler(f.path, f.ctx);
		expect(f.notices.some((notice) => notice.includes("selected for this session"))).toBe(false);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["wait", "input"] as const)("session replacement during %s discards pending selection", async (stage) => {
	const f = fixture();
	try {
		expect(f.commands.has("publication-config")).toBe(true);
		const replace = async () => { await f.handlers.get("session_shutdown")!({}, f.ctx); };
		if (stage === "wait") f.ctx.waitForIdle = replace;
		else f.ctx.ui.input = async () => { await replace(); return f.path; };
		await f.commands.get("publication-config")!.handler("", f.ctx);
		expect(f.notices.some((notice) => notice.includes("selected for this session"))).toBe(false);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("children cannot select a publication grant", async () => {
	const previous = process.env.PI_SUBAGENT_AGENT;
	process.env.PI_SUBAGENT_AGENT = "fixture-child";
	const f = fixture(true);
	try {
		expect(f.commands.has("publication-config")).toBe(false);
		await expect(f.push()).rejects.toThrow("Subagents cannot commit or push");
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_AGENT;
		else process.env.PI_SUBAGENT_AGENT = previous;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("missing token names only its variable and performs no provider request", async () => {
	let requests = 0;
	const runtime = createPublicationRuntime({ events: events as never, cwd: "/owned/repo", config, env: {}, fetch: async () => { requests++; throw new Error("must not fetch"); } });
	await expect(runtime.resolveTarget(config.pushUrl, "alan/ENG-fixture")).rejects.toThrow("GitLab token variable PUBLICATION_FIXTURE_TOKEN is unset");
	expect(requests).toBe(0);
});
