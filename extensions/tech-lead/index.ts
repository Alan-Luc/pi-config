import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildEnvironment } from "../lib/shared.ts";
import { appendInstructions } from "../artifact-contracts/render.ts";

const SUBAGENT_TOOLS = ["subagent", "subagent_resume", "subagent_kill"];
const UNUSED_TASK_TOOLS = ["TaskOutput", "TaskStop", "TaskExecute"];

/** Appends the ported opencode tech-lead instructions to the main session's system prompt only. */
export default function registerTechLead(
	pi: ExtensionAPI,
	env: Readonly<Record<string, string | undefined>> = process.env,
	instructions = readFileSync(new URL("./tech-lead.md", import.meta.url), "utf8"),
): void {
	if (isSubagentChildEnvironment(env)) return;

	const heading = "## Slice and delegate";
	const start = instructions.indexOf(`${heading}\n`);
	if (start === -1) throw new Error(`tech-lead.md is missing the "${heading}" heading`);
	const next = instructions.indexOf("\n## ", start + heading.length);
	const soloInstructions =
		instructions.slice(0, start) +
		`${heading}\n\nSolo mode: work directly; do not delegate to subagents.\n` +
		(next === -1 ? "" : instructions.slice(next));

	let soloTools: string[] | undefined; // tools active before solo; defined iff solo is on
	pi.on("session_start", () => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => !UNUSED_TASK_TOOLS.includes(name)));
	});
	pi.on("before_agent_start", (event) =>
		appendInstructions(event.systemPromptOptions, soloTools ? soloInstructions : instructions),
	);
	pi.registerCommand("solo", {
		description: "Toggle solo mode: no subagent delegation",
		handler: async (_args, ctx) => {
			if (soloTools) {
				pi.setActiveTools(soloTools);
				soloTools = undefined;
			} else {
				soloTools = pi.getActiveTools();
				pi.setActiveTools(soloTools.filter((name) => !SUBAGENT_TOOLS.includes(name)));
			}
			ctx.ui.notify(soloTools ? "Solo mode on: delegation disabled" : "Solo mode off: delegation restored", "info");
		},
	});
}
