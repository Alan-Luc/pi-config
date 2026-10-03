import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBriefHook } from "./briefs.ts";
import { registerDocumentHooks } from "./documents.ts";
import { registerHandoffHooks } from "./handoffs.ts";

/** Enforces artifact schemas: subagent briefs and replies, plans, handoff documents; protects daily logs and legacy records. */
export default function artifactContracts(pi: ExtensionAPI): void {
	registerDocumentHooks(pi);
	registerBriefHook(pi);
	registerHandoffHooks(pi);
}
