import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { Type } from "typebox";
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCandidateIdentity, getVerificationEvidence, verificationEvidenceErrors, sealedVerificationEvidenceErrors, type CandidateIdentity, type VerificationEvidence } from "./verification-store.ts";
import { currentAssignment, sameAssignment, type AssignmentSnapshot } from "./assignment.ts";
import { renderResultSubmission, resultSubmissionErrors, type ResultFields, type ResultSubmissionRecord } from "./result-submission.ts";
import { ownedWorkErrors, ownedWorkErrorsSync } from "./handoffs.ts";
import { captureCandidateSync, captureCandidateWithExec } from "./verification.ts";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";
import { runtimeManifest } from "./staged-verification.ts";
import { requestWorkStatus } from "../lib/work-status.ts";
import { requestBackgroundWorkStatusSync } from "./background-tasks.ts";
import type { ResultSchemaId } from "./schemas.ts";

export type FrozenPublicationCandidate = Readonly<{ head: string; tree: string; branch: string; indexTree: string; statusDigest: string; inputDigest: string }>;

export const FINALIZE_RESULT_REQUEST = "artifact-contracts:finalize-result:request:v1";
export const FINALIZE_RESULT_RESPONSE = "artifact-contracts:finalize-result:response:v1";
export const FINALIZED_RESULT_ENTRY = "artifact-contracts.finalized-result.v1";
export const DELEGATION_RESULT_REQUEST = "workflow:delegation-result:request:v1";
export const DELEGATION_RESULT_RESPONSE = "workflow:delegation-result:response:v1";
export const PUBLICATION_CLEARANCE_QUERY = "pi-guardrails:publication-clearance:query:v1";
export const PUBLICATION_CLEARANCE_RECORD = "pi-guardrails:publication-clearance:record:v1";
export const PUBLICATION_CLEARANCE_DIAGNOSE = "pi-guardrails:publication-clearance:diagnose:v1";
export const PUBLICATION_CLEARANCE_DIAGNOSIS = "pi-guardrails:publication-clearance:diagnosis:v1";
export const LAUNCH_BINDING_ENV = "PI_SUBAGENT_PUBLICATION_BINDING";

export type PublicationLaunchBinding = Readonly<{
	parentSessionId: string;
	parentLeafIdAtLaunch: string;
	launchToolCallId: string;
	childId: string;
	incarnationId: string;
	canonicalSessionFile: string;
	entryFloor: number;
}>;
export type FinalizedResultEnvelope = Readonly<{
	version: 1;
	launchBinding: PublicationLaunchBinding;
	rootGeneration: string;
	assignment: AssignmentSnapshot;
	finalAssistantEntryId: string;
	resultSchemaId: ResultSchemaId;
	validatedFields: ResultFields;
	renderedSha256: string;
	candidate: CandidateIdentity;
	inputPins: readonly Readonly<{ path: string; sha256: string }>[];
	proofs: readonly VerificationEvidence[];
}>;
export type FinalizedResultRef = Readonly<{
	state: "finalized";
	entryId: string;
	envelopeSha256: string;
	childSessionId: string;
	rootGeneration: string;
	incarnationId: string;
}>;
export type FinalizeResultRequest = Readonly<{
	version: 1;
	requestId: string;
	childSessionId: string;
	incarnationId: string;
	expectedLeafId: string;
	context: ExtensionContext;
}>;
export type FinalizeResultResponse = Readonly<{
	version: 1;
	requestId: string;
	childSessionId: string;
	incarnationId: string;
	rootGeneration: string;
	finalize: () => Promise<FinalizedResultRef | Readonly<{ state: "unavailable"; reason: string }>>;
}>;

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textHash = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
const closed = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function parseLaunchBinding(value: unknown): PublicationLaunchBinding | undefined {
	if (!isRecord(value) || !closed(value, ["parentSessionId", "parentLeafIdAtLaunch", "launchToolCallId", "childId", "incarnationId", "canonicalSessionFile", "entryFloor"])) return undefined;
	if (![value.parentSessionId, value.parentLeafIdAtLaunch, value.launchToolCallId, value.childId, value.incarnationId, value.canonicalSessionFile].every(identifier)
		|| typeof value.entryFloor !== "number" || !Number.isSafeInteger(value.entryFloor) || value.entryFloor < 0) return undefined;
	return value as PublicationLaunchBinding;
}

function candidateMatches(left: CandidateIdentity, right: CandidateIdentity): boolean {
	return left.repositoryRoot === right.repositoryRoot && left.head === right.head && left.tree === right.tree && left.kind === right.kind;
}

export function publicationEvidenceErrors(ids: readonly string[], candidate: CandidateIdentity, sealed = false): string[] {
	if (ids.length === 0 || new Set(ids).size !== ids.length) return ["publication requires unique successful evidence IDs"];
	return ids.flatMap((id) => {
		const evidence = getVerificationEvidence(id);
		if (!evidence) return [`publication evidence ${id} is missing`];
		let pinError: string[] = [];
		try { inputPins([evidence]); } catch (error) { pinError = [`publication runtime input pin invalid: ${error instanceof Error ? error.message : String(error)}`]; }
		return [
			...pinError,
			...(sealed ? sealedVerificationEvidenceErrors(id) : verificationEvidenceErrors(id)),
			...(evidence.exitCode === 0 ? [] : [`publication evidence ${id} has nonzero exit ${evidence.exitCode}`]),
			...(candidateMatches(evidence.candidate, candidate) ? [] : [`publication evidence ${id} belongs to another candidate`]),
		];
	});
}

function inputPins(proofs: readonly VerificationEvidence[]): readonly Readonly<{ path: string; sha256: string }>[] {
	const pins = new Map<string, string>();
	for (const proof of proofs) for (const pin of proof.candidate.runtimeInputs ?? []) {
		if (pins.has(pin.path) && pins.get(pin.path) !== pin.sha256) throw new Error("verification input pins disagree");
		if (runtimeManifest(proof.candidate.repositoryRoot, pin.path) !== pin.sha256) throw new Error(`verification input changed: ${pin.path}`);
		pins.set(pin.path, pin.sha256);
	}
	return [...pins].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
}

export function registerResultFinalizer(pi: ExtensionAPI, snapshot: () => Readonly<{
	assignment: AssignmentSnapshot | undefined;
	submission: ResultSubmissionRecord | undefined;
	activeVerificationCalls: number;
}>): void {
	let generation = randomUUID();
	let enabled = true;
	pi.on("session_start", () => { generation = randomUUID(); enabled = true; });
	pi.on("session_shutdown", () => { enabled = false; generation = randomUUID(); });
	pi.events.on(FINALIZE_RESULT_REQUEST, (value) => {
		if (!enabled || !isRecord(value) || !closed(value, ["version", "requestId", "childSessionId", "incarnationId", "expectedLeafId", "context"])
			|| value.version !== 1 || !identifier(value.requestId) || !identifier(value.childSessionId) || !identifier(value.incarnationId) || !identifier(value.expectedLeafId)
			|| !isRecord(value.context) || !isRecord(value.context.sessionManager)) return;
		const request = value as FinalizeResultRequest;
		const issuedGeneration = generation;
		let used = false;
		pi.events.emit(FINALIZE_RESULT_RESPONSE, {
			version: 1, requestId: request.requestId, childSessionId: request.childSessionId, incarnationId: request.incarnationId, rootGeneration: issuedGeneration,
			async finalize() {
				try {
					if (used) throw new Error("finalization capability already consumed");
					used = true;
					const ctx = request.context;
					const binding = parseLaunchBinding(JSON.parse(process.env[LAUNCH_BINDING_ENV] ?? "null"));
					if (!binding || binding.incarnationId !== request.incarnationId || ctx.sessionManager.getSessionId() !== request.childSessionId
						|| realpathSync(ctx.sessionManager.getSessionFile() ?? "") !== binding.canonicalSessionFile) throw new Error("finalization launch/session owner mismatch");
					const initial = snapshot();
					const assignment = currentAssignment(ctx.sessionManager);
					const submission = initial.submission;
					if (!assignment || !submission || !initial.assignment || !sameAssignment(initial.assignment, assignment)
						|| !sameAssignment(submission.assignment, assignment) || ctx.sessionManager.getLeafId() !== request.expectedLeafId) throw new Error("finalization assignment or leaf changed");
					const lines = readFileSync(binding.canonicalSessionFile, "utf8").trimEnd().split("\n");
					const persisted: unknown[] = lines.map((line) => JSON.parse(line));
					if (persisted.findIndex((entry) => isRecord(entry) && entry.id === assignment.requestEntryId) < binding.entryFloor) throw new Error("inherited request is not this launch assignment");
					const rendered = renderResultSubmission(submission.schemaId, submission.fields);
					if (rendered.errors.length > 0) throw new Error(rendered.errors.join("; "));
					const final = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
					if (!final || final.type !== "message" || final.message.role !== "assistant" || final.message.stopReason !== "stop") throw new Error("final assistant is not successfully completed");
					const renderedText = final.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
					if (renderedText !== rendered.text) throw new Error("persisted final assistant differs from validated result");
					const proofIds = submission.fields.proofIds;
					if (submission.schemaId === "worker" && !strings(proofIds)) throw new Error("worker proof IDs unavailable");
					const ids = strings(proofIds) ? proofIds : [];
					const proofs = ids.map((id) => {
						const proof = getVerificationEvidence(id);
						if (!proof) throw new Error(`proof ${id} unavailable`);
						return proof;
					});
					const candidate = await captureCandidateWithExec(pi.exec, ctx.cwd);
					const errors = await ownedWorkErrors(pi.events, snapshot().activeVerificationCalls, assignment.sessionId, true);
					if (ids.length > 0) errors.push(...publicationEvidenceErrors(ids, candidate));
					if (submission.schemaId === "worker" && ids.length === 0) errors.push("worker requires successful independent proof");
					if (errors.length > 0) throw new Error(errors.join("; "));
					const pins = inputPins(proofs);
					if (!candidateMatches(candidate, await captureCandidateWithExec(pi.exec, ctx.cwd))) throw new Error("source changed during finalization");
					const terminalErrors = await ownedWorkErrors(pi.events, snapshot().activeVerificationCalls, assignment.sessionId, true);
					if (ids.length > 0) terminalErrors.push(...publicationEvidenceErrors(ids, candidate));
					if (terminalErrors.length > 0) throw new Error(terminalErrors.join("; "));
					if (digest(inputPins(proofs)) !== digest(pins)) throw new Error("input pins changed during finalization");
					if (!enabled || ctx.signal?.aborted || generation !== issuedGeneration || snapshot().submission !== submission || ctx.sessionManager.getLeafId() !== request.expectedLeafId
						|| !sameAssignment(assignment, currentAssignment(ctx.sessionManager) ?? { sessionId: "", requestEntryId: "", branchEntryIds: [] })) throw new Error("finalization owner changed during validation");
					const envelope: FinalizedResultEnvelope = { version: 1, launchBinding: binding, rootGeneration: issuedGeneration, assignment,
						finalAssistantEntryId: final.id, resultSchemaId: submission.schemaId, validatedFields: submission.fields, renderedSha256: textHash(rendered.text), candidate, inputPins: pins, proofs };
					pi.appendEntry(FINALIZED_RESULT_ENTRY, envelope);
					const entryId = ctx.sessionManager.getLeafId();
					if (!entryId) throw new Error("finalization entry was not persisted");
					return { state: "finalized" as const, entryId, envelopeSha256: digest(envelope), childSessionId: assignment.sessionId, rootGeneration: issuedGeneration, incarnationId: binding.incarnationId };
				} catch (error) {
					return { state: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) };
				}
			},
		} satisfies FinalizeResultResponse);
	});
}

function parseCandidate(value: unknown): CandidateIdentity | undefined {
	if (!isRecord(value) || !identifier(value.id) || !identifier(value.repositoryRoot) || !(value.head === null || identifier(value.head))
		|| !identifier(value.tree) || (value.kind !== "clean" && value.kind !== "dirty") || (value.source !== undefined && value.source !== "staged")) return undefined;
	if (value.runtimeInputs !== undefined && (!Array.isArray(value.runtimeInputs) || !value.runtimeInputs.every((pin) => isRecord(pin) && closed(pin, ["path", "sha256"]) && identifier(pin.path) && sha256(pin.sha256)))) return undefined;
	const candidate = value as CandidateIdentity;
	return createCandidateIdentity(candidate).id === candidate.id ? candidate : undefined;
}

export function parseFinalizedEnvelope(value: unknown): FinalizedResultEnvelope | undefined {
	if (!isRecord(value) || !closed(value, ["version", "launchBinding", "rootGeneration", "assignment", "finalAssistantEntryId", "resultSchemaId", "validatedFields", "renderedSha256", "candidate", "inputPins", "proofs"])
		|| value.version !== 1 || !parseLaunchBinding(value.launchBinding) || !identifier(value.rootGeneration) || !identifier(value.finalAssistantEntryId)
		|| !sha256(value.renderedSha256) || !parseCandidate(value.candidate) || !isRecord(value.assignment)
		|| !closed(value.assignment, ["sessionId", "requestEntryId", "branchEntryIds"]) || !identifier(value.assignment.sessionId) || !identifier(value.assignment.requestEntryId)
		|| !strings(value.assignment.branchEntryIds) || !value.assignment.branchEntryIds.includes(value.assignment.requestEntryId)
		|| !value.assignment.branchEntryIds.includes(value.finalAssistantEntryId)
		|| (value.resultSchemaId !== "worker" && value.resultSchemaId !== "review" && value.resultSchemaId !== "explorer")
		|| !isRecord(value.validatedFields) || resultSubmissionErrors(value.resultSchemaId, value.validatedFields).length > 0
		|| !Array.isArray(value.inputPins) || !value.inputPins.every((pin) => isRecord(pin) && closed(pin, ["path", "sha256"]) && identifier(pin.path) && sha256(pin.sha256))
		|| !Array.isArray(value.proofs)) return undefined;
	for (const proof of value.proofs) {
		if (!isRecord(proof) || !identifier(proof.id) || !identifier(proof.command) || !Array.isArray(proof.argv) || !proof.argv.every((arg) => typeof arg === "string")
			|| !identifier(proof.cwd) || !parseCandidate(proof.candidate) || proof.exitCode !== 0 || proof.valid !== true || !identifier(proof.logPath) || !sha256(proof.logSha256)) return undefined;
	}
	return value as FinalizedResultEnvelope;
}

type SelectedLane = Readonly<{ slot: "correctness-primary" | "correctness-counterpart" | "live-success" | "live-attack"; childId: string; incarnationId: string }>;
type ResolvedLane = Readonly<{ selection: SelectedLane; ownerGeneration: string; envelope: FinalizedResultEnvelope; refDigest: string }>;
type LaunchAssignment = Readonly<{ assignment: AssignmentSnapshot; childIds: ReadonlySet<string> }>;
type PublicationSeal = Readonly<{
	clearedAt: number; wireEvidenceIds: readonly string[];
	candidate: CandidateIdentity; frozen: FrozenPublicationCandidate; evidenceIds: readonly string[];
	pins: readonly Readonly<{ path: string; sha256: string }>[]; lanes: readonly ResolvedLane[];
	assignment: AssignmentSnapshot; generation: string;
	workOwners: Readonly<{ verificationGeneration: string; delegationGeneration: string; delegationRevision: number; backgroundGeneration: string; backgroundRevision: string }>;
}>;

function resolveLane(events: EventBus, sessionId: string, selection: SelectedLane, launches: ReadonlyMap<string, LaunchAssignment>, assignment: AssignmentSnapshot): ResolvedLane {
	const request = { version: 1, requestId: randomUUID(), sessionId, childId: selection.childId, incarnationId: selection.incarnationId };
	const replies: unknown[] = [];
	const off = events.on(DELEGATION_RESULT_RESPONSE, (reply) => replies.push(reply));
	try { events.emit(DELEGATION_RESULT_REQUEST, request); } finally { off(); }
	function fail(reason: string, recovery: string): never {
		throw new Error(`Publication lane ${selection.slot} childId=${JSON.stringify(selection.childId)} incarnationId=${JSON.stringify(selection.incarnationId)}: ${reason}. Recovery: ${recovery}`);
	}
	const repairProvider = "Check the loaded subagent extension and its result protocol. Repair missing, duplicate or incompatible providers before retrying clearance; rerunning passing tests does not repair result lookup.";
	if (replies.length === 0) fail("no delegation result response", repairProvider);
	if (replies.length !== 1) fail(`${replies.length} delegation result responses`, repairProvider);
	const reply = replies[0];
	if (!isRecord(reply)) fail("delegation result response is not an object", repairProvider);
	for (const key of ["version", "requestId", "sessionId", "childId", "incarnationId"] as const) {
		if (reply[key] !== request[key]) fail(`${key} mismatch`, repairProvider);
	}
	if (!identifier(reply.generation)) fail("invalid delegation result generation", repairProvider);
	if (!Number.isSafeInteger(reply.revision) || Number(reply.revision) < 0) fail("invalid delegation result revision", repairProvider);
	if (reply.state === "running") fail('state="running"', "Wait for this worker's terminal result notification, then use its finalized Publication lane identity. Do not poll or rerun passing tests.");
	if (reply.state === "missing") fail('state="missing"', "Check childId and incarnationId against a finalized Publication lane report from this parent session. If its result registry was reset, launch a replacement lane on the unchanged candidate; retrying clearance alone cannot restore it.");
	if (reply.state === "unavailable") {
		const reason = typeof reply.reason === "string" ? `; provider reason=${JSON.stringify(reply.reason.slice(0, 512))}` : "";
		fail(`state="unavailable"${reason}`, "Use the latest finalized Publication lane identity from this parent session. Inspect the worker's result and finalization; resume the worker to repair incomplete finalization, or launch a replacement lane if its binding is no longer current. A passing verification receipt alone cannot replace a finalized lane result.");
	}
	if (reply.state !== "completed") fail(`unexpected result state=${JSON.stringify(reply.state)}`, repairProvider);
	if (!closed(reply, ["version", "requestId", "sessionId", "childId", "incarnationId", "generation", "revision", "state", "launchBinding", "status", "envelope", "ref"])) fail("invalid completed response fields", repairProvider);
	if (reply.status !== "completed") fail(`status=${JSON.stringify(reply.status)}`, "Inspect the worker's failure and repair or replace that lane on the unchanged candidate. Use its finalized Publication lane identity before retrying clearance.");
	const envelope = parseFinalizedEnvelope(JSON.parse(JSON.stringify(reply.envelope)));
	const binding = parseLaunchBinding(reply.launchBinding);
	if (!envelope || !binding || digest(binding) !== digest(envelope.launchBinding) || binding.parentSessionId !== sessionId
		|| binding.childId !== selection.childId || binding.incarnationId !== selection.incarnationId || !isRecord(reply.ref)
		|| !closed(reply.ref, ["state", "entryId", "envelopeSha256", "childSessionId", "rootGeneration", "incarnationId"])
		|| reply.ref.state !== "finalized" || reply.ref.incarnationId !== selection.incarnationId || reply.ref.rootGeneration !== envelope.rootGeneration
		|| reply.ref.childSessionId !== envelope.assignment.sessionId || reply.ref.envelopeSha256 !== digest(envelope) || !identifier(reply.ref.entryId)) fail("selected result proof envelope owner mismatch", "Check the finalized Publication lane identity and the subagent extension's result protocol. Repair or replace this lane's finalization; do not substitute a plain-text report or verification receipt.");
	const launched = launches.get(binding.launchToolCallId);
	if (!launched || !launched.childIds.has(selection.childId) || !sameAssignment(launched.assignment, assignment)
		|| !assignment.branchEntryIds.includes(binding.parentLeafIdAtLaunch)) fail("selected result is not bound to an observed parent launch/assignment", "Select a finalized lane launched for this assignment in this parent session. If the parent assignment or launch registry changed, launch a replacement lane for the current candidate.");
	if (envelope.validatedFields.status !== "done") fail("selected lane did not complete", "Inspect the worker's blocked or incomplete result. Resolve its blocker and resume it, or launch a replacement lane; select its finalized Publication lane identity.");
	if (selection.slot.startsWith("correctness")) {
		if (envelope.resultSchemaId !== "review" || !["APPROVE", "APPROVE WITH CHANGES"].includes(String(envelope.validatedFields.verdict))
			|| (Array.isArray(envelope.validatedFields.critical) && envelope.validatedFields.critical.length > 0)
			|| (Array.isArray(envelope.validatedFields.important) && envelope.validatedFields.important.length > 0)) fail("correctness lane lacks validated approval without unresolved material findings", "Resolve material review findings, verify the repaired candidate, and obtain a finalized approving review for that candidate.");
	} else if (envelope.resultSchemaId !== "worker" || envelope.proofs.length === 0) fail("independent live lane lacks proof", "Have the live worker collect successful verification evidence and submit a finalized worker result referencing its proof IDs for the current candidate.");
	return { selection, ownerGeneration: reply.generation, envelope, refDigest: digest(reply.ref) };
}

function importedProofErrors(lane: ResolvedLane, candidate: CandidateIdentity): string[] {
	const envelope = lane.envelope;
	const errors: string[] = [];
	if (!candidateMatches(envelope.candidate, candidate)) errors.push("selected lane candidate differs from committed publication source");
	const ids = envelope.proofs.map((proof) => proof.id);
	const declaredIds = envelope.validatedFields.proofIds;
	if (envelope.resultSchemaId === "worker" && (!strings(declaredIds) || digest(declaredIds) !== digest(ids))) errors.push("selected lane proof references differ from finalized evidence");
	for (const proof of envelope.proofs) {
		if (!candidateMatches(proof.candidate, candidate) || !proof.valid || proof.exitCode !== 0) errors.push("selected lane evidence is not successful current-candidate proof");
		if (`verify_${digest([proof.command, proof.cwd, proof.candidate.id, proof.exitCode, proof.logSha256])}` !== proof.id) errors.push("selected lane proof identity mismatch");
		try { if (textHash(readFileSync(proof.logPath)) !== proof.logSha256) errors.push("selected lane proof log changed"); }
		catch { errors.push("selected lane proof log missing"); }
	}
	try { if (digest(inputPins(envelope.proofs)) !== digest(envelope.inputPins)) errors.push("selected lane input pins disagree"); }
	catch { errors.push("selected lane runtime inputs changed"); }
	return errors;
}

const selectionSchema = Type.Object({ slot: Type.Union([Type.Literal("correctness-primary"), Type.Literal("correctness-counterpart"), Type.Literal("live-success"), Type.Literal("live-attack")]), childId: Type.String({ minLength: 1 }), incarnationId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export function registerPublicationClearance(pi: ExtensionAPI): void {
	if (isSubagentChildEnvironment()) return;
	let generation = randomUUID();
	let ownerSessionId: string | undefined;
	let ownerContext: ExtensionContext | undefined;
	let seal: PublicationSeal | undefined;
	let ownerAssignment: AssignmentSnapshot | undefined;
	let activityRevision = 0;
	let lastProofInvalidation = "producer initialization";
	const freshEvidenceIds = new Set<string>();
	const startedChecks = new Map<string, number>();
	const verificationCalls = new Map<string, { revision: number | undefined; operation: string; taskId?: string }>();
	const writeCapableCalls = new Set<string>();
	const launches = new Map<string, LaunchAssignment>();
	const expireUnsealedProofs = (reason: string) => { activityRevision++; freshEvidenceIds.clear(); lastProofInvalidation = reason; };
	const reset = (reason: string) => {
		seal = undefined;
		launches.clear();
		generation = randomUUID();
		verificationCalls.clear();
		writeCapableCalls.clear();
		startedChecks.clear();
		expireUnsealedProofs(reason);
	};
	pi.on("session_start", (_event, ctx) => { reset("session_start"); ownerSessionId = ctx.sessionManager.getSessionId(); ownerContext = ctx; ownerAssignment = currentAssignment(ctx.sessionManager); });
	pi.on("agent_start", (_event, ctx) => {
		const next = currentAssignment(ctx.sessionManager);
		if (ownerAssignment && (!next || !sameAssignment(ownerAssignment, next))) reset(`owner assignment changed to ${next?.requestEntryId ?? "unavailable"}`);
		ownerAssignment = next;
	});
	pi.on("session_shutdown", () => { reset("session_shutdown"); ownerSessionId = undefined; ownerContext = undefined; });
	pi.on("session_tree", () => { reset("session_tree"); });
	pi.on("tool_call", (event, ctx) => {
		ownerContext = ctx;
		if (event.toolName === "verification_evidence") {
			const operation = isRecord(event.input) && typeof event.input.operation === "string" ? event.input.operation : "run";
			const taskId = isRecord(event.input) && identifier(event.input.taskId) ? event.input.taskId : undefined;
			verificationCalls.set(event.toolCallId, { operation, taskId, revision: operation === "collect" ? (taskId ? startedChecks.get(taskId) : undefined) : activityRevision });
		}
		const nestedVerificationBash = event.toolName === "bash" && event.parentToolCallId !== undefined && verificationCalls.has(event.parentToolCallId);
		if (!nestedVerificationBash && ["bash", "edit", "write"].includes(event.toolName)) {
			writeCapableCalls.add(event.toolCallId);
			expireUnsealedProofs(`${event.toolName} tool_call ${event.toolCallId}`);
		}
		if (event.toolName === "subagent") {
			const assignment = currentAssignment(ctx.sessionManager);
			if (assignment) launches.set(event.toolCallId, { assignment, childIds: new Set() });
		}
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "verification_evidence") {
			const check = verificationCalls.get(event.toolCallId);
			verificationCalls.delete(event.toolCallId);
			if (check && !event.isError && isRecord(event.details) && event.details.protocolVersion === 2 && event.details.operation === check.operation) {
				if (check.operation === "start" && identifier(event.details.taskId) && check.revision !== undefined) startedChecks.set(event.details.taskId, check.revision);
				if ((check.operation === "run" || check.operation === "collect") && isRecord(event.details.evidence) && identifier(event.details.evidence.id)) {
					const proof = getVerificationEvidence(event.details.evidence.id);
					if (check.revision === activityRevision && proof?.valid && proof.exitCode === 0) freshEvidenceIds.add(proof.id);
					if (check.taskId) startedChecks.delete(check.taskId);
				}
			}
		}
		if (writeCapableCalls.delete(event.toolCallId)) expireUnsealedProofs(`${event.toolName} tool_result ${event.toolCallId}`);
		const launch = launches.get(event.toolCallId);
		if (!launch || event.toolName !== "subagent" || event.isError || !isRecord(event.details)) return;
		const details = event.details;
		const children = Array.isArray(details.children) ? details.children : [details];
		const childIds = new Set(children.filter(isRecord).flatMap((child) => identifier(child.id) ? [child.id] : []));
		launches.set(event.toolCallId, { ...launch, childIds });
	});
	function git(ctx: ExtensionContext, args: string[], deadline: number): string {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("publication Git identity deadline exceeded");
		const result = spawnSync("git", args, { cwd: ctx.cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(10_000, remaining), killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
		if (result.error || result.signal || result.status !== 0) throw new Error("publication Git identity unavailable");
		return result.stdout.trim();
	}
	function freeze(ctx: ExtensionContext, candidate: CandidateIdentity, pins: PublicationSeal["pins"], deadline = Date.now() + 30_000): FrozenPublicationCandidate {
		const [branch, indexTree, status] = [git(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"], deadline), git(ctx, ["write-tree"], deadline), git(ctx, ["status", "--porcelain=v1", "--untracked-files=all"], deadline)];
		if (candidate.kind !== "clean" || !candidate.head || candidate.tree !== indexTree || status) throw new Error("publication requires a clean committed source and index");
		return Object.freeze({ head: candidate.head, tree: candidate.tree, branch, indexTree, statusDigest: digest(status), inputDigest: digest(pins) });
	}
	function workOwners(): PublicationSeal["workOwners"] {
		if (!ownerSessionId) throw new Error("publication work owner unavailable");
		const verification = requestWorkStatus(pi.events, "verification", ownerSessionId);
		const delegation = requestWorkStatus(pi.events, "delegation", ownerSessionId);
		const background = requestBackgroundWorkStatusSync(pi.events, ownerSessionId);
		if (!verification || !delegation) throw new Error("publication work owner status unavailable");
		return { verificationGeneration: verification.generation, delegationGeneration: delegation.generation,
			delegationRevision: delegation.revision, backgroundGeneration: background.generation, backgroundRevision: background.revision };
	}
	function proofFailureReason(errors: readonly string[]): string {
		if (errors.some((error) => /log hash|log is missing|log is unreadable/.test(error))) return "A sealed proof receipt's proof log is missing, unreadable, or has changed.";
		if (errors.some((error) => /nonzero exit/.test(error))) return "A sealed proof receipt no longer has a successful exit status.";
		if (errors.some((error) => /runtime input pin invalid|verification input changed/.test(error))) return "The runtime input pin changed after sealing.";
		if (errors.some((error) => /candidate/.test(error))) return "A sealed proof receipt no longer matches the sealed candidate.";
		if (errors.some((error) => /obsolete|stale/.test(error))) return "A newer or invalidating verification attempt made a sealed proof receipt stale.";
		return "A sealed proof receipt failed its current validity check.";
	}
	type CurrentnessFailure = Readonly<{ state: "binding_mismatch" | "stale_seal"; reason: string }>;
	function currentFailure(selected: PublicationSeal, binding?: Record<string, unknown>): CurrentnessFailure | undefined {
		try {
			const ctx = ownerContext;
			if (!ctx || !ownerSessionId || selected !== seal || selected.generation !== generation || ownerSessionId !== selected.assignment.sessionId) {
				return { state: "stale_seal", reason: "The producer session or seal generation changed." };
			}
			if (binding && (binding.sessionId !== ownerSessionId || binding.repositoryRoot !== selected.candidate.repositoryRoot || binding.candidateSha !== selected.candidate.head || binding.branch !== selected.frozen.branch)) {
				return { state: "binding_mismatch", reason: "The request session, repository root, candidate, or branch does not match the sealed identity." };
			}
			const assignment = currentAssignment(ctx.sessionManager);
			if (!assignment || !sameAssignment(selected.assignment, assignment)) return { state: "stale_seal", reason: "The owner assignment changed after sealing." };
			if (ownedWorkErrorsSync(pi.events, verificationCalls.size, ownerSessionId, true).length > 0) return { state: "stale_seal", reason: "Owner work status reports active or uncollected work." };
			if (digest(workOwners()) !== digest(selected.workOwners)) return { state: "stale_seal", reason: "The verification, delegation, or background work-owner revision changed." };
			const proofErrors = publicationEvidenceErrors(selected.evidenceIds, selected.candidate, true);
			if (proofErrors.length > 0) return { state: "stale_seal", reason: proofFailureReason(proofErrors) };
			for (const pin of selected.pins) if (runtimeManifest(selected.candidate.repositoryRoot, pin.path) !== pin.sha256) {
				return { state: "stale_seal", reason: "A pinned runtime input changed after sealing." };
			}
			for (const lane of selected.lanes) {
				let latest: ResolvedLane;
				try { latest = resolveLane(pi.events, ownerSessionId, lane.selection, launches, selected.assignment); }
				catch { return { state: "stale_seal", reason: "The finalized lane result is unavailable or failed validation." }; }
				if (latest.ownerGeneration !== lane.ownerGeneration || latest.refDigest !== lane.refDigest || digest(latest.envelope) !== digest(lane.envelope)) {
					return { state: "stale_seal", reason: "The finalized lane identity or envelope changed after sealing." };
				}
				if (importedProofErrors(latest, selected.candidate).length > 0) return { state: "stale_seal", reason: "A finalized lane proof failed currentness validation." };
			}
			const deadline = Date.now() + 30_000;
			if (binding) {
				const pushUrls = git(ctx, ["remote", "get-url", "--push", "--all", "origin"], deadline).split("\n");
				if (pushUrls.length !== 1 || pushUrls[0] !== binding.pushUrl) return { state: "binding_mismatch", reason: "The request push URL does not match the single effective origin push URL." };
			}
			const candidate = captureCandidateSync(ctx.cwd, selected.candidate.repositoryRoot, selected.candidate.source, deadline);
			const frozen = freeze(ctx, candidate, selected.pins, deadline);
			if (ownedWorkErrorsSync(pi.events, verificationCalls.size, ownerSessionId, true).length > 0) return { state: "stale_seal", reason: "Owner work status changed during currentness validation." };
			if (digest(workOwners()) !== digest(selected.workOwners)) return { state: "stale_seal", reason: "The work-owner revision changed during currentness validation." };
			const refreshedProofErrors = publicationEvidenceErrors(selected.evidenceIds, selected.candidate, true);
			if (refreshedProofErrors.length > 0) return { state: "stale_seal", reason: proofFailureReason(refreshedProofErrors) };
			for (const pin of selected.pins) if (runtimeManifest(selected.candidate.repositoryRoot, pin.path) !== pin.sha256) {
				return { state: "stale_seal", reason: "The runtime input pin changed during currentness validation." };
			}
			for (const lane of selected.lanes) {
				let latest: ResolvedLane;
				try { latest = resolveLane(pi.events, ownerSessionId, lane.selection, launches, selected.assignment); }
				catch { return { state: "stale_seal", reason: "The finalized lane result became unavailable during currentness validation." }; }
				if (latest.ownerGeneration !== lane.ownerGeneration || latest.refDigest !== lane.refDigest || digest(latest.envelope) !== digest(lane.envelope)) {
					return { state: "stale_seal", reason: "The finalized lane identity or envelope changed during currentness validation." };
				}
			}
			if (!candidateMatches(candidate, selected.candidate) || digest(frozen) !== digest(selected.frozen)) return { state: "stale_seal", reason: "The frozen Git candidate or source state changed after sealing." };
			if (selected !== seal || selected.generation !== generation) return { state: "stale_seal", reason: "The seal generation changed during currentness validation." };
			return undefined;
		} catch {
			return { state: "stale_seal", reason: "A source, Git, or owner-status currentness check could not complete." };
		}
	}
	function current(selected: PublicationSeal, binding?: Record<string, unknown>): boolean {
		return currentFailure(selected, binding) === undefined;
	}
	pi.registerTool({
		name: "publication_clearance", label: "Publication clearance", description: "Seal fresh postcommit proof and authoritative independent lane results for a separately granted task-branch push. Does not grant or perform publication.",
		parameters: Type.Object({ tier: Type.Union([Type.Literal("Direct"), Type.Literal("Focused"), Type.Literal("Full")]), evidenceIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }), lanes: Type.Array(selectionSchema), adjudication: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			seal = undefined;
			ownerContext = ctx;
			const assignment = currentAssignment(ctx.sessionManager);
			if (!assignment || !ownerSessionId || assignment.sessionId !== ownerSessionId) throw new Error("publication owner assignment unavailable");
			const slots = params.lanes.map((lane) => lane.slot);
			const required = params.tier === "Full" ? ["correctness-primary", "correctness-counterpart", "live-success", "live-attack"] : params.tier === "Focused" ? ["correctness-primary", "live-success"] : [];
			if (new Set(slots).size !== slots.length || required.some((slot) => !slots.includes(slot as SelectedLane["slot"]))
				|| new Set(params.lanes.map((lane) => lane.childId)).size !== params.lanes.length) throw new Error(`publication requires complete distinct selected lanes; required: ${required.join(", ") || "none"}; missing: ${required.filter((slot) => !slots.includes(slot as SelectedLane["slot"])).join(", ") || "none"}; Recovery: use childId and incarnationId from finalized Publication lane reports for distinct required lanes`);
			const capturedGeneration = generation;
			const capturedActivity = activityRevision;
			if (params.evidenceIds.some((id) => !freshEvidenceIds.has(id))) throw new Error(`publication requires fresh owner-observed proof after tool activity. Last invalidation: ${lastProofInvalidation}. Recovery: finish owner Bash, edit and write calls, then use verification_evidence start and collect in this loaded session before publication_clearance. A successful receipt alone does not prove this producer observed its start.`);
			const candidate = await captureCandidateWithExec(pi.exec, ctx.cwd);
			const errors = publicationEvidenceErrors(params.evidenceIds, candidate);
			errors.push(...await ownedWorkErrors(pi.events, verificationCalls.size, ownerSessionId, true));
			const lanes = params.lanes.map((selection) => resolveLane(pi.events, ownerSessionId!, selection, launches, assignment));
			for (const lane of lanes) errors.push(...importedProofErrors(lane, candidate));
			if (errors.length > 0) throw new Error(errors.join("; "));
			const proofs = params.evidenceIds.map((id) => getVerificationEvidence(id)!);
			const pins = inputPins([...proofs, ...lanes.flatMap((lane) => lane.envelope.proofs)]);
			const frozen = freeze(ctx, candidate, pins);
			const workOwnerSnapshot = workOwners();
			const sealId = randomUUID();
			const clearedAt = Date.now();
			const next: PublicationSeal = { clearedAt,
				wireEvidenceIds: params.evidenceIds.map((id) => `seal:${sealId}:${id}`),
				candidate, frozen, evidenceIds: [...params.evidenceIds], pins, lanes, assignment, generation: capturedGeneration, workOwners: workOwnerSnapshot };
			seal = next;
			if (capturedActivity !== activityRevision || !current(next) || capturedActivity !== activityRevision) { seal = undefined; throw new Error("publication state changed while sealing"); }
			return { content: [{ type: "text", text: "Publication proof sealed locally; a separate exact external grant and scanner clearance are still required." }], details: { candidate: frozen, laneCount: lanes.length } };
		},
	});
	pi.events.on(PUBLICATION_CLEARANCE_DIAGNOSE, (value) => {
		const keys = ["version", "requestId", "sessionId", "repositoryRoot", "candidateSha", "pushUrl", "branch"];
		if (!isRecord(value) || !closed(value, keys) || value.version !== 1 || !identifier(value.requestId)
			|| !identifier(value.sessionId) || !identifier(value.repositoryRoot) || !identifier(value.candidateSha)
			|| !identifier(value.pushUrl) || !identifier(value.branch)) return;
		const selected = seal;
		let state: "missing_seal" | "binding_mismatch" | "stale_seal";
		let reason: string;
		if (!selected) {
			state = "missing_seal";
			reason = "No clearance seal exists in this producer session.";
		} else {
			const failure = currentFailure(selected, value);
			if (!failure) return;
			state = failure.state;
			reason = failure.reason;
		}
		const tools = new Set(pi.getAllTools().map((tool) => tool.name));
		const missingTools = ["verification_evidence", "publication_clearance"].filter((name) => !tools.has(name));
		const freshProof = [...freshEvidenceIds].map(getVerificationEvidence).find((proof) => proof
			&& proof.candidate.repositoryRoot === value.repositoryRoot && proof.candidate.head === value.candidateSha
			&& publicationEvidenceErrors([proof.id], proof.candidate).length === 0);
		let nextStep: string;
		if (state === "binding_mismatch") {
			nextStep = `Use the exact sealed sessionId, repositoryRoot, candidateSha, branch, and the single effective origin push URL. Sealed identity: ${JSON.stringify({ sessionId: selected?.assignment.sessionId, repositoryRoot: selected?.candidate.repositoryRoot, candidateSha: selected?.candidate.head, branch: selected?.frozen.branch })}. Return to that session and candidate, or obtain clearance for the current candidate; do not rerun checks to repair a binding mismatch.`;
		} else if (missingTools.length > 0) {
			nextStep = `${missingTools.join(" and ")} is not registered. Ask the operator to load the artifact-contracts tools in this Pi runtime before retrying. Do not rerun passing tests.`;
		} else if (freshProof) {
			nextStep = `Reuse current owner-observed evidenceIds:["${freshProof.id}"] and any other required current evidence. Do not rerun passing checks. Call publication_clearance({tier:"<ticket tier>",evidenceIds:["${freshProof.id}"],lanes:<finalized lane objects>,adjudication:"<summary>"}). Use lanes:[] for Direct. Focused requires correctness-primary and live-success; Full also requires correctness-counterpart and live-attack. Each lane needs slot, childId and incarnationId from a finalized result in this session. Repair missing lane results before retrying; do not substitute report text or invent IDs.`;
		} else {
			nextStep = "In this session, use verification_evidence({operation:\"capture\"}) to identify the candidate; capture creates no evidenceId. Then use verification_evidence({operation:\"start\",argv:[\"<executable>\",\"<argument>\"],cwd:\".\",timeout:60}) and collect with verification_evidence({operation:\"collect\",taskId:\"<returned taskId>\"}). Use the collected successful evidenceId in publication_clearance({tier:\"Focused\",evidenceIds:[\"<returned evidenceId>\"],lanes:[{slot:\"correctness-primary\",childId:\"<finalized childId>\",incarnationId:\"<finalized incarnationId>\"},{slot:\"live-success\",childId:\"<finalized childId>\",incarnationId:\"<finalized incarnationId>\"}],adjudication:\"<summary>\"}). Use lanes:[] for Direct. For Full, provide the same lane object shape for correctness-primary, correctness-counterpart, live-success, and live-attack. Replace every placeholder with a returned value. Use only finalized same-session lanes and fresh evidence; evidence cannot be reused from another session.";
		}
		pi.events.emit(PUBLICATION_CLEARANCE_DIAGNOSIS, { ...value, state, reason: reason.slice(0, 512), nextStep: nextStep.slice(0, 2000) });
	});
	pi.events.on(PUBLICATION_CLEARANCE_QUERY, (value) => {
		const keys = ["version", "requestId", "sessionId", "repositoryRoot", "candidateSha", "pushUrl", "branch"];
		if (!isRecord(value) || !closed(value, keys) || value.version !== 1 || !identifier(value.requestId)
			|| !identifier(value.sessionId) || !identifier(value.repositoryRoot) || !identifier(value.candidateSha)
			|| !identifier(value.pushUrl) || !identifier(value.branch)) return;
		const selected = seal;
		if (!selected || value.sessionId !== selected.assignment.sessionId || value.repositoryRoot !== selected.candidate.repositoryRoot
			|| value.candidateSha !== selected.candidate.head || value.branch !== selected.frozen.branch) return;
		try { if (realpathSync(value.repositoryRoot) !== selected.candidate.repositoryRoot) return; } catch { return; }
		if (!current(selected, value)) return;
		pi.events.emit(PUBLICATION_CLEARANCE_RECORD, {
			...value, evidenceIds: selected.wireEvidenceIds, clearedAt: selected.clearedAt,
		});
	});
}
