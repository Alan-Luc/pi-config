import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGuardrails } from "../extensions/guardrails/guardrails.ts";
import type { PublicationRuntime } from "../extensions/guardrails/publication.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function repository(url: string): string {
	const path = mkdtempSync(join(tmpdir(), "github-delivery-"));
	directories.push(path);
	execFileSync("git", ["init", "--quiet", path]);
	execFileSync("git", ["-C", path, "remote", "add", "origin", url]);
	return path;
}
function guard(command: string, cwd: string, env: Record<string, string | undefined> = {}, publication?: PublicationRuntime) {
	let handler: ((event: never, ctx: never) => unknown) | undefined;
	registerGuardrails({ on(name: string, callback: typeof handler) { if (name === "tool_call") handler = callback; } } as never, env, publication);
	if (!handler) throw new Error("tool_call guard missing");
	return handler({ toolName: "bash", toolCallId: "delivery", input: { command } } as never, { cwd } as never);
}
const branch = "benchmark/delivery-test";

test.each(["git@github.com:Alan-Luc/fixture.git", "https://github.com/Alan-Luc/fixture", "https://github.com/Alan-Luc/fixture.git"])("permits explicit repository selection for personal origin %s", async (url) => {
	const selected = repository(url);
	const caller = repository("https://example.invalid/work/repository");
	await guard(`git -C '${selected}' push origin ${branch}`, caller);
});

test("permits a plain push to the existing HTTPS personal origin", async () => {
	await guard(`git push origin ${branch}`, repository("https://github.com/Alan-Luc/fixture"));
});

test.each([
	"https://github.com/Someone-Else/fixture", "https://github.com.evil.invalid/Alan-Luc/fixture",
	"https://github.com/Alan-Luc/fixture/extra", "https://github.com/Alan-Luc/fixture?redirect=1",
	"https://github.com/Alan-Luc/fixture#fragment", "https://Alan-Luc@github.com/Alan-Luc/fixture",
	"https://github.com/Alan-Luc/fixture.git.evil/extra", "https://example.invalid/work/repository",
])("rejects foreign or ambiguous origin %s at the selected repository", async (url) => {
	const selected = repository(url);
	const caller = repository("git@github.com:Alan-Luc/caller.git");
	await expect(guard(`git -C '${selected}' push origin ${branch}`, caller)).rejects.toThrow("publication");
	await expect(guard(`git -C '${selected}' push origin alan/delivery-test`, caller)).rejects.toThrow("publication");
});

test.each([
	(repo: string) => `git -C '${repo}' push --force origin ${branch}`,
	(repo: string) => `git -C '${repo}' push origin HEAD:${branch}`,
	(repo: string) => `git -C '${repo}' push origin ${branch} && echo companion`,
	(repo: string) => `cd '${repo}' && git push origin ${branch}`,
	(repo: string) => `command git -C '${repo}' push origin ${branch}`,
	(repo: string) => `git --no-pager -C '${repo}' push origin ${branch}`,
	(repo: string) => `GIT_DIR='${repo}/.git' git push origin ${branch}`,
	() => `git -C '$REPOSITORY' push origin ${branch}`,
])("keeps unsafe or unsupported push spellings blocked %#", async (command) => {
	const repo = repository("https://github.com/Alan-Luc/fixture");
	await expect(guard(command(repo), repo)).rejects.toThrow();
});

test("children cannot use explicit repository selection", async () => {
	const repo = repository("https://github.com/Alan-Luc/fixture");
	await expect(guard(`git -C '${repo}' push origin ${branch}`, repo, { PI_SUBAGENT_AGENT: "worker" })).rejects.toThrow("Subagents cannot commit or push");
});

test("does not extend the runtime-backed publication surface", async () => {
	const repo = repository("https://github.com/Alan-Luc/fixture");
	const publication: PublicationRuntime = {
		cwd: repo, loadGrant: async () => undefined, resolveTarget: async () => undefined,
		loadFrozenCandidate: async () => undefined, isCandidateCurrent: async () => false,
		scan: async () => { throw new Error("scanner must not run"); },
	};
	await expect(guard(`git -C '${repo}' push origin ${branch}`, repo, {}, publication)).rejects.toThrow("standalone literal");
	await expect(guard(`git push origin ${branch}`, repo, {}, publication)).rejects.toThrow("publication");
});
