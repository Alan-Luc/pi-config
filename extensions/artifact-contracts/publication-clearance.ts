import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCandidateIdentity, getVerificationEvidence, verificationEvidenceErrors, type CandidateIdentity, type VerificationEvidence } from "./verification-store.ts";
import { currentAssignment, sameAssignment, type AssignmentSnapshot } from "./assignment.ts";
import { renderResultSubmission, resultSubmissionErrors, type ResultFields, type ResultSubmissionRecord } from "./result-submission.ts";
import { ownedWorkErrors } from "./handoffs.ts";
import { captureCandidateWithExec } from "./verification.ts";
import { isRecord } from "../lib/shared.ts";
import { runtimeManifest } from "./staged-verification.ts";
import type { ResultSchemaId } from "./schemas.ts";

export const FINALIZE_RESULT_REQUEST = "artifact-contracts:finalize-result:request:v1";
export const FINALIZE_RESULT_RESPONSE = "artifact-contracts:finalize-result:response:v1";
export const FINALIZED_RESULT_ENTRY = "artifact-contracts.finalized-result.v1";
export const DELEGATION_RESULT_REQUEST = "workflow:delegation-result:request:v1";
export const DELEGATION_RESULT_RESPONSE = "workflow:delegation-result:response:v1";
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

export function publicationEvidenceErrors(ids: readonly string[], candidate: CandidateIdentity): string[] {
	if (ids.length === 0 || new Set(ids).size !== ids.length) return ["publication requires unique successful evidence IDs"];
	return ids.flatMap((id) => {
		const evidence = getVerificationEvidence(id);
		if (!evidence) return [`publication evidence ${id} is missing`];
		let pinError: string[] = [];
		try { inputPins([evidence]); } catch (error) { pinError = [`publication runtime input pin invalid: ${error instanceof Error ? error.message : String(error)}`]; }
		return [
			...pinError,
			...verificationEvidenceErrors(id),
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
