import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";
import { appendInstructions, renderTemplate } from "./render.ts";
import { validate } from "./validate.ts";

type CheckResult = { block: false } | { block: true; reason: string };

function briefErrors(task: unknown, name?: string): string[] {
	const prefix = name === undefined ? "" : `${name}: `;
	if (typeof task !== "string") return [`${prefix}${task === undefined ? "missing task" : "task must be a string"}`];
	return validate("brief", task).errors.map((error) => `${prefix}${error}`);
}

export function checkSubagentLaunch(input: unknown): CheckResult {
	const launch = isRecord(input) ? input : {};
	const children = launch.children;
	const errors = Array.isArray(children) && children.length > 0
		? children.flatMap((child) => {
				const childLaunch = isRecord(child) ? child : {};
				const name = typeof childLaunch.name === "string" ? childLaunch.name : undefined;
				return briefErrors(childLaunch.task, name);
			})
		: briefErrors(launch.task);

	if (errors.length === 0) return { block: false };
	return { block: true, reason: `${errors.join("\n")}\nTemplate:\n${renderTemplate("brief")}` };
}

export function briefInstructions(): string {
	return ["Every `subagent` task (and each `children[].task`) must fill exactly this template; launches that do not validate are blocked.", "Template:", renderTemplate("brief")].join("\n");
}

export function registerBriefHook(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>> = process.env): void {
	// Children rarely launch subagents; they still get the template in any rejection.
	if (!isSubagentChildEnvironment(env)) {
		pi.on("before_agent_start", (event) => {
			if (pi.getActiveTools().includes("subagent")) appendInstructions(event.systemPromptOptions, briefInstructions());
		});
	}
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		const result = checkSubagentLaunch(event.input);
		// Pi keeps the last truthy tool_call result, so a pass must return nothing.
		return result.block ? result : undefined;
	});
}
