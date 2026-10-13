import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBriefHook } from "./briefs.ts";
import { registerDocumentHooks } from "./documents.ts";
import { registerHandoffHooks } from "./handoffs.ts";
import { registerVerificationEvidence } from "./verification.ts";
import { ARTIFACT_CAPABILITY_VERSION } from "./schemas.ts";

export const ARTIFACT_CAPABILITY_REQUEST_CHANNEL = "artifact-contracts:capability-request";
export const ARTIFACT_CAPABILITY_CHANNEL = "artifact-contracts:capability";
const ARTIFACT_CAPABILITY = { version: ARTIFACT_CAPABILITY_VERSION, mutations: true } as const;

export function registerArtifactCapability(pi: Pick<ExtensionAPI, "events">): void {
	const announce = () => pi.events.emit(ARTIFACT_CAPABILITY_CHANNEL, ARTIFACT_CAPABILITY);
	pi.events.on(ARTIFACT_CAPABILITY_REQUEST_CHANNEL, announce);
	announce();
}

/** Enforces artifact schemas: subagent briefs and replies, plans, handoff documents; protects daily logs and legacy records. */
export default function artifactContracts(pi: ExtensionAPI): void {
	registerArtifactCapability(pi);
	registerDocumentHooks(pi);
	registerBriefHook(pi);
	registerHandoffHooks(pi);
	registerVerificationEvidence(pi);
}
