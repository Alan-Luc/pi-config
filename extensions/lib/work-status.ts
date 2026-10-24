import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./shared.ts";

export const VERIFICATION_STATUS_REQUEST = "workflow:verification-status:request:v1";
export const VERIFICATION_STATUS_RESPONSE = "workflow:verification-status:response:v1";
export const DELEGATION_STATUS_REQUEST = "workflow:delegation-status:request:v1";
export const DELEGATION_STATUS_RESPONSE = "workflow:delegation-status:response:v1";

export type WorkStatusRequest = Readonly<{ version: 1; requestId: string; sessionId: string }>;
type StatusIdentity = WorkStatusRequest & Readonly<{ generation: string }>;
export type VerificationStatus = StatusIdentity & Readonly<{ starting: number; uncollectedTaskIds: readonly string[] }>;
export type DelegationStatus = StatusIdentity & Readonly<{ revision: number; runningChildIds: readonly string[]; pendingResultIds: readonly string[] }>;

function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function identifiers(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
}
function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseWorkStatusRequest(value: unknown): WorkStatusRequest | undefined {
	if (!isRecord(value) || Object.keys(value).length !== 3 || value.version !== 1
		|| !identifier(value.requestId) || !identifier(value.sessionId)) return undefined;
	return { version: 1, requestId: value.requestId, sessionId: value.sessionId };
}

/** Snapshot producers reply synchronously; silence or multiple replies is unknown. */
export function requestWorkStatus(events: EventBus, owner: "verification", sessionId: string): VerificationStatus | undefined;
export function requestWorkStatus(events: EventBus, owner: "delegation", sessionId: string): DelegationStatus | undefined;
export function requestWorkStatus(
	events: EventBus,
	owner: "verification" | "delegation",
	sessionId: string,
): VerificationStatus | DelegationStatus | undefined {
	const request = parseWorkStatusRequest({ version: 1, requestId: randomUUID(), sessionId });
	if (!request) return undefined;
	const [requestChannel, responseChannel] = owner === "verification"
		? [VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE]
		: [DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE];
	const replies: unknown[] = [];
	const unsubscribe = events.on(responseChannel, (reply) => replies.push(reply));
	try {
		events.emit(requestChannel, request);
	} catch {
		return undefined;
	} finally {
		unsubscribe();
	}
	if (replies.length !== 1) return undefined;
	const reply = replies[0];
	if (!isRecord(reply) || reply.version !== 1 || reply.requestId !== request.requestId
		|| reply.sessionId !== sessionId || !identifier(reply.generation)) return undefined;
	const identity: StatusIdentity = { ...request, generation: reply.generation };
	if (owner === "verification") {
		if (Object.keys(reply).length !== 6 || !count(reply.starting) || !identifiers(reply.uncollectedTaskIds)) return undefined;
		return { ...identity, starting: reply.starting, uncollectedTaskIds: [...reply.uncollectedTaskIds] };
	}
	if (Object.keys(reply).length !== 7 || !count(reply.revision) || !identifiers(reply.runningChildIds) || !identifiers(reply.pendingResultIds)) return undefined;
	return { ...identity, revision: reply.revision, runningChildIds: [...reply.runningChildIds], pendingResultIds: [...reply.pendingResultIds] };
}
