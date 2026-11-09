import { resolve } from "node:path";
import { getEffectiveAgentDefinitions } from "../../git/github.com/Alan-Luc/pi-subagents/src/agents/definitions.ts";

export function getLocalAgentDefinitions() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = resolve(import.meta.dir, "../..");
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		return getEffectiveAgentDefinitions(root);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}
