import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildEnvironment } from "../lib/shared.ts";
import { PublicationPrerequisiteError } from "./publication.ts";
import { createPublicationRuntime, loadPublicationConfig } from "./publication-runtime.ts";
import { registerGuardrails } from "./guardrails.ts";

export default function guardrails(pi: ExtensionAPI): void {
	let selectedPath: string | undefined;
	let generation = 0;
	const reset = () => { selectedPath = undefined; generation++; };
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	if (!isSubagentChildEnvironment()) pi.registerCommand("publication-config", {
		description: "Select an existing external publication grant for this session; does not grant or perform a push.",
		async handler(_args, ctx) {
			if (!ctx.hasUI) { ctx.ui.notify("Publication configuration selection requires native UI.", "error"); return; }
			const capturedGeneration = generation;
			const sessionId = ctx.sessionManager.getSessionId();
			await ctx.waitForIdle();
			if (generation !== capturedGeneration || ctx.sessionManager.getSessionId() !== sessionId) return;
			const path = await ctx.ui.input("Select existing publication grant", "Absolute path to an operator-managed grant JSON file");
			if (!path) return;
			if (!isAbsolute(path)) { ctx.ui.notify("Publication configuration requires an absolute path.", "error"); return; }
			try {
				await loadPublicationConfig(path);
				if (generation !== capturedGeneration || ctx.sessionManager.getSessionId() !== sessionId) return;
				selectedPath = path;
				ctx.ui.notify("Publication configuration selected for this session. Fresh proof, clearance, target checks, scanning, and separate push authorization remain required.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof PublicationPrerequisiteError ? error.message : "Publication configuration selection failed.", "error");
			}
		},
	});
	registerGuardrails(pi, process.env, async (cwd) => {
		if (!pi.events) return undefined;
		const config = await loadPublicationConfig(selectedPath ?? process.env.PI_PUBLICATION_CONFIG_PATH);
		return createPublicationRuntime({ events: pi.events, cwd, config, env: process.env });
	});
}
