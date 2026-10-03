import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardrails } from "./guardrails.ts";

/** Logic guardrails: push shape, worktree containment, git retargeting, light-review artifacts, infra-retry suppression. */
export default function guardrails(pi: ExtensionAPI): void {
	registerGuardrails(pi);
}
