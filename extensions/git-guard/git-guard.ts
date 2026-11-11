import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";

const TEST_COMMAND = /\b(?:manage\.py\s+test|pytest|pytests?|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|go\s+test|cargo\s+test|jest|vitest|mocha|rspec|phpunit|gradle\s+test|mvn\s+test)\b/i;
const DATABASE_FAILURE = /(?:ECONNREFUSED|connection refused|could not connect to server|unable to create a connection to the 'postgres' database|database .*?(?:unavailable|down)|db(?:\s+)?(?:blocked|down)|OperationalError|timeout(?:ed)? out|no route to host|temporary failure in name resolution|psql: error|mysql:.*(?:gone away|can't connect)|sqlite.*locked|localhost:55432)/i;
const RETRY_OVERRIDE = /\bPI_ALLOW_INFRA_RETRY=1\b/;
const GIT_MUTATION = /^\s*git\s+(?:commit|push)\b/;

function normalize(command: string): string {
	return command.replace(RETRY_OVERRIDE, "").trim().replace(/\s+/g, " ");
}

function resultText(event: ToolResultEvent): string {
	return event.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

export function registerGitGuard(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>> = process.env): void {
	const isChild = isSubagentChildEnvironment(env);
	const failedCommands = new Set<string>();
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (!isChild || !["bash", "bg_run"].includes(event.toolName) || !isRecord(event.input) || typeof event.input.command !== "string") return;
		if (GIT_MUTATION.test(event.input.command)) {
			throw new Error("Subagents cannot commit or push; report changes to the parent, which owns commits and task-branch pushes under policy.");
		}
	});
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash" || !isRecord(event.input) || typeof event.input.command !== "string") return;
		const command = event.input.command;
		if (TEST_COMMAND.test(command) && failedCommands.has(normalize(command)) && !RETRY_OVERRIDE.test(command)) {
			const error = new Error("Blocked repeat bash command after an unchanged DB/infrastructure failure in this session.") as Error & { code: string };
			error.code = "infra_retry";
			throw error;
		}
	});
	pi.on("tool_result", (event: ToolResultEvent) => {
		if (event.toolName !== "bash" || !isRecord(event.input) || typeof event.input.command !== "string" || !TEST_COMMAND.test(event.input.command)) return;
		const command = normalize(event.input.command);
		if (DATABASE_FAILURE.test(resultText(event))) failedCommands.add(command);
		else failedCommands.delete(command);
	});
}
