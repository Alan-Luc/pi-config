export const invocations = {
	allowed: 0,
	denied: 0,
	relay: 0,
};

const parameters = { type: "object", properties: {}, additionalProperties: false };

function fakeTool(name, execute, exposure = "direct") {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters,
		exposure,
		async execute() {
			return execute();
		},
	};
}

export const allowedTool = fakeTool("mcp__fixture_allowed__probe", async () => {
	invocations.allowed++;
	return { content: [{ type: "text", text: "allowed" }] };
});

export const deniedTool = fakeTool("mcp__fixture_denied__probe", async () => {
	invocations.denied++;
	return { content: [{ type: "text", text: "denied" }] };
});

export const relayTool = {
	name: "fixture_relay",
	label: "fixture_relay",
	description: "Fake nested dispatcher",
	parameters,
	exposure: "codemode",
	async execute(_id, _params, _signal, _onUpdate, context) {
		invocations.relay++;
		const denied = await context.executeTool("mcp__fixture_denied__probe", {});
		return { ...denied.result, isError: denied.isError };
	},
};
