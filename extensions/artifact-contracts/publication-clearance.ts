import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FrozenPublicationCandidate } from "../guardrails/publication.ts";
import { createCandidateIdentity, getVerificationEvidence, verificationEvidenceErrors, sealedVerificationEvidenceErrors, type CandidateIdentity, type VerificationEvidence } from "./verification-store.ts";
import { currentAssignment, sameAssignment, type AssignmentSnapshot } from "./assignment.ts";
import { renderResultSubmission, resultSubmissionErrors, type ResultFields, type ResultSubmissionRecord } from "./result-submission.ts";
import { ownedWorkErrors } from "./handoffs.ts";
import { captureCandidateWithExec } from "./verification.ts";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";
import { runtimeManifest } from "./staged-verification.ts";
import type { ResultSchemaId } from "./schemas.ts";

export const FINALIZE_RESULT_REQUEST = "artifact-contracts:finalize-result:request:v1";
export const FINALIZE_RESULT_RESPONSE = "artifact-contracts:finalize-result:response:v1";
export const FINALIZED_RESULT_ENTRY = "artifact-contracts.finalized-result.v1";
export const DELEGATION_RESULT_REQUEST = "workflow:delegation-result:request:v1";
export const DELEGATION_RESULT_RESPONSE = "workflow:delegation-result:response:v1";
export const PUBLICATION_CLEARANCE_REQUEST = "artifact-contracts:publication-clearance:request:v1";
export const PUBLICATION_CLEARANCE_RESPONSE = "artifact-contracts:publication-clearance:response:v1";
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
export type PublicationClearanceRequest = Readonly<{ version: 1; requestId: string; cwd: string }>;
export type PublicationClearanceResponse = PublicationClearanceRequest & Readonly<{
	loadFrozenCandidate: () => Promise<FrozenPublicationCandidate | undefined>;
	isCandidateCurrent: (candidate: FrozenPublicationCandidate) => Promise<boolean>;
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
	candidate: CandidateIdentity; frozen: FrozenPublicationCandidate; evidenceIds: readonly string[];
	pins: readonly Readonly<{ path: string; sha256: string }>[]; lanes: readonly ResolvedLane[];
	assignment: AssignmentSnapshot; generation: string;
}>;

function resolveLane(events: EventBus, sessionId: string, selection: SelectedLane, launches: ReadonlyMap<string, LaunchAssignment>, assignment: AssignmentSnapshot): ResolvedLane {
	const request = { version: 1, requestId: randomUUID(), sessionId, childId: selection.childId, incarnationId: selection.incarnationId };
	const replies: unknown[] = [];
	const off = events.on(DELEGATION_RESULT_RESPONSE, (reply) => replies.push(reply));
	try { events.emit(DELEGATION_RESULT_REQUEST, request); } finally { off(); }
	if (replies.length !== 1) throw new Error("delegation result capability unavailable or ambiguous");
	const reply = replies[0];
	if (!isRecord(reply) || !closed(reply, ["version", "requestId", "sessionId", "childId", "incarnationId", "generation", "revision", "state", "launchBinding", "status", "envelope", "ref"])
		|| reply.version !== 1 || reply.requestId !== request.requestId || reply.sessionId !== sessionId
		|| reply.childId !== selection.childId || reply.incarnationId !== selection.incarnationId || !identifier(reply.generation)
		|| !Number.isSafeInteger(reply.revision) || Number(reply.revision) < 0 || reply.state !== "completed" || reply.status !== "completed") throw new Error("selected result is unavailable, running or failed");
	const envelope = parseFinalizedEnvelope(JSON.parse(JSON.stringify(reply.envelope)));
	const binding = parseLaunchBinding(reply.launchBinding);
	if (!envelope || !binding || digest(binding) !== digest(envelope.launchBinding) || binding.parentSessionId !== sessionId
		|| binding.childId !== selection.childId || binding.incarnationId !== selection.incarnationId || !isRecord(reply.ref)
		|| !closed(reply.ref, ["state", "entryId", "envelopeSha256", "childSessionId", "rootGeneration", "incarnationId"])
		|| reply.ref.state !== "finalized" || reply.ref.incarnationId !== selection.incarnationId || reply.ref.rootGeneration !== envelope.rootGeneration
		|| reply.ref.childSessionId !== envelope.assignment.sessionId || reply.ref.envelopeSha256 !== digest(envelope) || !identifier(reply.ref.entryId)) throw new Error("selected result proof envelope owner mismatch");
	const launched = launches.get(binding.launchToolCallId);
	if (!launched || !launched.childIds.has(selection.childId) || !sameAssignment(launched.assignment, assignment)
		|| !assignment.branchEntryIds.includes(binding.parentLeafIdAtLaunch)) throw new Error("selected result is not bound to an observed parent launch/assignment");
	if (envelope.validatedFields.status !== "done") throw new Error("selected lane did not complete");
	if (selection.slot.startsWith("correctness")) {
		if (envelope.resultSchemaId !== "review" || !["APPROVE", "APPROVE WITH CHANGES"].includes(String(envelope.validatedFields.verdict))
			|| (Array.isArray(envelope.validatedFields.critical) && envelope.validatedFields.critical.length > 0)
			|| (Array.isArray(envelope.validatedFields.important) && envelope.validatedFields.important.length > 0)) throw new Error("correctness lane lacks validated approval without unresolved material findings");
	} else if (envelope.resultSchemaId !== "worker" || envelope.proofs.length === 0) throw new Error("independent live lane lacks proof");
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
	const freshEvidenceIds = new Set<string>();
	const startedChecks = new Map<string, number>();
	const verificationCalls = new Map<string, { revision: number | undefined; operation: string; taskId?: string }>();
	const writeCapableCalls = new Set<string>();
	const launches = new Map<string, LaunchAssignment>();
	const expireUnsealedProofs = () => { activityRevision++; freshEvidenceIds.clear(); };
	const reset = () => {
		seal = undefined;
		launches.clear();
		generation = randomUUID();
		verificationCalls.clear();
		writeCapableCalls.clear();
		startedChecks.clear();
		expireUnsealedProofs();
	};
	pi.on("session_start", (_event, ctx) => { reset(); ownerSessionId = ctx.sessionManager.getSessionId(); ownerContext = ctx; ownerAssignment = currentAssignment(ctx.sessionManager); });
	pi.on("agent_start", (_event, ctx) => {
		const next = currentAssignment(ctx.sessionManager);
		if (ownerAssignment && (!next || !sameAssignment(ownerAssignment, next))) reset();
		ownerAssignment = next;
	});
	pi.on("session_shutdown", () => { reset(); ownerSessionId = undefined; ownerContext = undefined; });
	pi.on("session_tree", () => { reset(); });
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
			expireUnsealedProofs();
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
		if (writeCapableCalls.delete(event.toolCallId)) expireUnsealedProofs();
		const launch = launches.get(event.toolCallId);
		if (!launch || event.toolName !== "subagent" || event.isError || !isRecord(event.details)) return;
		const details = event.details;
		const children = Array.isArray(details.children) ? details.children : [details];
		const childIds = new Set(children.filter(isRecord).flatMap((child) => identifier(child.id) ? [child.id] : []));
		launches.set(event.toolCallId, { ...launch, childIds });
	});
	async function git(ctx: ExtensionContext, args: string[]): Promise<string> {
		const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 10_000 });
		if (result.code !== 0 || result.killed) throw new Error("publication Git identity unavailable");
		return result.stdout.trim();
	}
	async function freeze(ctx: ExtensionContext, candidate: CandidateIdentity, pins: PublicationSeal["pins"]): Promise<FrozenPublicationCandidate> {
		const [branch, indexTree, status] = await Promise.all([git(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"]), git(ctx, ["write-tree"]), git(ctx, ["status", "--porcelain=v1", "--untracked-files=all"])]);
		if (candidate.kind !== "clean" || !candidate.head || candidate.tree !== indexTree || status) throw new Error("publication requires a clean committed source and index");
		return Object.freeze({ head: candidate.head, tree: candidate.tree, branch, indexTree, statusDigest: digest(status), inputDigest: digest(pins) });
	}
	async function current(selected: PublicationSeal): Promise<boolean> {
		try {
			const ctx = ownerContext;
			if (!ctx || !ownerSessionId || selected !== seal || selected.generation !== generation || ownerSessionId !== selected.assignment.sessionId) return false;
			const assignment = currentAssignment(ctx.sessionManager);
			if (!assignment || !sameAssignment(selected.assignment, assignment)) return false;
			if ((await ownedWorkErrors(pi.events, verificationCalls.size, ownerSessionId, true)).length > 0) return false;
			if (publicationEvidenceErrors(selected.evidenceIds, selected.candidate, true).length > 0) return false;
			for (const pin of selected.pins) if (runtimeManifest(selected.candidate.repositoryRoot, pin.path) !== pin.sha256) return false;
			for (const lane of selected.lanes) {
				const latest = resolveLane(pi.events, ownerSessionId, lane.selection, launches, selected.assignment);
				if (latest.ownerGeneration !== lane.ownerGeneration || latest.refDigest !== lane.refDigest || digest(latest.envelope) !== digest(lane.envelope)
					|| importedProofErrors(latest, selected.candidate).length > 0) return false;
			}
			const candidate = await captureCandidateWithExec(pi.exec, ctx.cwd);
			const frozen = await freeze(ctx, candidate, selected.pins);
			if ((await ownedWorkErrors(pi.events, verificationCalls.size, ownerSessionId, true)).length > 0
				|| publicationEvidenceErrors(selected.evidenceIds, selected.candidate, true).length > 0) return false;
			for (const pin of selected.pins) if (runtimeManifest(selected.candidate.repositoryRoot, pin.path) !== pin.sha256) return false;
			for (const lane of selected.lanes) {
				const latest = resolveLane(pi.events, ownerSessionId, lane.selection, launches, selected.assignment);
				if (latest.ownerGeneration !== lane.ownerGeneration || latest.refDigest !== lane.refDigest || digest(latest.envelope) !== digest(lane.envelope)) return false;
			}
			return candidateMatches(candidate, selected.candidate) && digest(frozen) === digest(selected.frozen)
				&& selected === seal && selected.generation === generation;
		} catch { return false; }
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
			const required = params.tier === "Full" ? ["correctness-primary", "correctness-counterpart", "live-success", "live-attack"] : params.tier === "Focused" ? ["correctness-primary", "correctness-counterpart", "live-success"] : [];
			if (new Set(slots).size !== slots.length || required.some((slot) => !slots.includes(slot as SelectedLane["slot"]))
				|| new Set(params.lanes.map((lane) => lane.childId)).size !== params.lanes.length) throw new Error("publication requires complete distinct selected lanes");
			const capturedGeneration = generation;
			const capturedActivity = activityRevision;
			if (params.evidenceIds.some((id) => !freshEvidenceIds.has(id))) throw new Error("publication requires fresh owner-observed proof after tool activity");
			const candidate = await captureCandidateWithExec(pi.exec, ctx.cwd);
			const errors = publicationEvidenceErrors(params.evidenceIds, candidate);
			errors.push(...await ownedWorkErrors(pi.events, verificationCalls.size, ownerSessionId, true));
			const lanes = params.lanes.map((selection) => resolveLane(pi.events, ownerSessionId!, selection, launches, assignment));
			for (const lane of lanes) errors.push(...importedProofErrors(lane, candidate));
			if (errors.length > 0) throw new Error(errors.join("; "));
			const proofs = params.evidenceIds.map((id) => getVerificationEvidence(id)!);
			const pins = inputPins([...proofs, ...lanes.flatMap((lane) => lane.envelope.proofs)]);
			const frozen = await freeze(ctx, candidate, pins);
			const next: PublicationSeal = { candidate, frozen, evidenceIds: [...params.evidenceIds], pins, lanes, assignment, generation: capturedGeneration };
			seal = next;
			if (capturedActivity !== activityRevision || !(await current(next)) || capturedActivity !== activityRevision) { seal = undefined; throw new Error("publication state changed while sealing"); }
			return { content: [{ type: "text", text: "Publication proof sealed locally; a separate exact external grant and scanner clearance are still required." }], details: { candidate: frozen, laneCount: lanes.length } };
		},
	});
	pi.events.on(PUBLICATION_CLEARANCE_REQUEST, (value) => {
		if (!isRecord(value) || !closed(value, ["version", "requestId", "cwd"]) || value.version !== 1 || !identifier(value.requestId) || !identifier(value.cwd) || !ownerContext) return;
		try { if (realpathSync(resolve(value.cwd)) !== realpathSync(ownerContext.cwd)) return; } catch { return; }
		pi.events.emit(PUBLICATION_CLEARANCE_RESPONSE, { version: 1, requestId: value.requestId, cwd: value.cwd,
			async loadFrozenCandidate() { const selected = seal; return selected && await current(selected) ? selected.frozen : undefined; },
			async isCandidateCurrent(candidate: FrozenPublicationCandidate) { const selected = seal; return !!selected && digest(candidate) === digest(selected.frozen) && await current(selected); },
		} satisfies PublicationClearanceResponse);
	});
}
