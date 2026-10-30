import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPublicationRuntime, loadPublicationConfig } from "./publication-runtime.ts";
import { registerGuardrails } from "./guardrails.ts";

/** Logic guardrails: push shape, worktree containment, Git retargeting, review artifacts, and infra-retry suppression. */
export default function guardrails(pi: ExtensionAPI): void {
	registerGuardrails(pi, process.env, async (cwd) => {
		if (!pi.events) return undefined;
		const config = await loadPublicationConfig(process.env.PI_PUBLICATION_CONFIG_PATH);
		return createPublicationRuntime({ events: pi.events, cwd, config, env: process.env });
	});
}
