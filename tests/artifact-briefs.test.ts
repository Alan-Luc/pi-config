import assert from "node:assert/strict";
import { test } from "bun:test";
import { briefInstructions, checkSubagentLaunch, registerBriefHook } from "../extensions/artifact-contracts/briefs.ts";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";

const contextLines = [
	"- Source of truth: Active plan and decisions.",
	"- Verified facts: The cited repository patterns are current.",
	"- Read first: The smallest exact owned paths.",
	"- Open questions: None.",
] as const;

const validBrief = [
	"## Objective",
	"Deliver the requested result.",
	"",
	"## Context",
	...contextLines,
	"",
	"## Scope",
	"Change only the owned files.",
	"",
	"## Constraints",
	"Preserve validation and run focused checks.",
	"",
	"## Done when",
	"The focused checks pass.",
].join("\n");

function blocked(result: ReturnType<typeof checkSubagentLaunch>): string {
	assert.equal(result.block, true);
	return result.block ? result.reason : "";
}

test("single briefs pass when valid and block with the template when invalid", () => {
	assert.deepEqual(checkSubagentLaunch({ task: validBrief }), { block: false });

	const reason = blocked(checkSubagentLaunch({ task: "## Objective\nIncomplete" }));
	assert.match(reason, /missing section/);
	assert.equal(reason.endsWith(`Template:\n${renderTemplate("brief")}`), true);
});

test.each([
	["missing", contextLines.slice(0, 3)],
	["blank", [...contextLines.slice(0, 2), "- Read first: ", contextLines[3]]],
	["duplicate", [...contextLines.slice(0, 3), contextLines[2]]],
	["reordered", [contextLines[1], contextLines[0], ...contextLines.slice(2)]],
	["extra", [...contextLines, "- Extra: not allowed"]],
] as const)("brief Context rejects %s evidence packets", (_case, lines) => {
	const brief = validBrief.replace(contextLines.join("\n"), lines.join("\n"));
	assert.match(blocked(checkSubagentLaunch({ task: brief })), /Context|Source of truth|Verified facts|Read first|Open questions/);
});

test("the rendered brief template owns the canonical evidence labels and remains unfilled", () => {
	const template = renderTemplate("brief");
	for (const label of ["Source of truth", "Verified facts", "Read first", "Open questions"]) {
		assert.equal((template.match(new RegExp(`- ${label}:`, "g")) ?? []).length, 1, label);
	}
	assert.equal((blocked(checkSubagentLaunch({ task: template })).match(/fill marker/g) ?? []).length, 8);
});

test("non-empty children are validated by name and empty children fall back to task", () => {
	assert.deepEqual(
		checkSubagentLaunch({
			children: [
				{ name: "first-child", task: validBrief },
				{ name: "second-child", task: validBrief },
			],
		}),
		{ block: false },
	);

	const reason = blocked(
		checkSubagentLaunch({
			children: [
				{ name: "valid-child", task: validBrief },
				{ name: "invalid-child", task: "## Objective\nIncomplete" },
			],
		}),
	);
	assert.match(reason, /invalid-child: .*missing section/);

	assert.deepEqual(checkSubagentLaunch({ children: [], task: validBrief }), { block: false });
	assert.equal(blocked(checkSubagentLaunch({ children: [], task: "invalid" })).includes("Template:"), true);
});

test("missing and non-string tasks block without mutating input", () => {
	const input = { children: [{ name: "missing-child" }] };
	const snapshot = structuredClone(input);
	const reason = blocked(checkSubagentLaunch(input));
	assert.match(reason, /missing-child: missing task/);
	assert.deepEqual(input, snapshot);

	assert.match(blocked(checkSubagentLaunch({ task: 42 })), /task must be a string/);
});

test("the registered hook only checks subagent calls", () => {
	type Event = { toolName: string; input: unknown };
	let handler: ((event: Event) => unknown) | undefined;
	const fakePi = {
		on(event: string, next: (event: Event) => unknown): () => void {
			if (event === "tool_call") handler = next;
			return () => undefined;
		},
	};

	registerBriefHook(fakePi as never, {});
	assert.ok(handler);
	assert.equal(handler({ toolName: "read", input: { task: "invalid" } }), undefined);
	const result = handler({ toolName: "subagent", input: { task: "invalid" } });
	assert.equal((result as { block: boolean }).block, true);
	assert.equal(handler({ toolName: "subagent", input: { task: validBrief } }), undefined);
});

test("main sessions receive the template only while subagent is active; children do not", () => {
	const registered = (env: Record<string, string>, tools = ["subagent"]) => {
		const starts: ((event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void)[] = [];
		registerBriefHook(
			{
				on: (event: string, next: never) => (event === "before_agent_start" && starts.push(next), () => undefined),
				getActiveTools: () => tools,
			} as never,
			env,
		);
		return starts;
	};

	const [start] = registered({});
	assert.ok(start);
	const unset: { appendSystemPrompt?: string } = {};
	start({ systemPromptOptions: unset });
	assert.equal(unset.appendSystemPrompt, briefInstructions());
	const prior = { appendSystemPrompt: "Prior" };
	start({ systemPromptOptions: prior });
	assert.equal(prior.appendSystemPrompt, `Prior\n\n${briefInstructions()}`);
	assert.ok(briefInstructions().includes(renderTemplate("brief")));

	const [inactiveStart] = registered({}, ["read"]);
	const inactive: { appendSystemPrompt?: string } = {};
	inactiveStart({ systemPromptOptions: inactive });
	assert.equal(inactive.appendSystemPrompt, undefined);

	const [toggledStart] = registered({}, ["read", "subagent"]);
	const toggled: { appendSystemPrompt?: string } = {};
	toggledStart({ systemPromptOptions: toggled });
	assert.equal(toggled.appendSystemPrompt, briefInstructions());

	assert.equal(registered({ PI_SUBAGENT_AGENT: "code-explorer" }).length, 0);
});
