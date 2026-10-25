import { Type, type TSchema } from "typebox";
import {
	RESULT_EVIDENCE_REFERENCE_PATTERN,
	RESULT_FINDING_FIELDS,
	RESULT_SUPPLEMENTAL_FIELDS,
	SCHEMAS,
	type ResultSchemaId,
} from "./schemas.ts";
import { getVerificationEvidence, verificationEvidenceErrors } from "./verification-store.ts";

export type ResultFields = Readonly<Record<string, unknown>>;
export type RenderedResult = Readonly<{ text: string; errors: readonly string[] }>;
export type ResultSubmissionRecord = Readonly<{
	version: 1;
	schemaId: ResultSchemaId;
	assignment: Readonly<{ sessionId: string; requestEntryId: string; branchEntryIds: readonly string[] }>;
	fields: ResultFields;
}>;

type FieldDefinition = Readonly<{ field: string; kind: "text" | "lines" | "choice" | "findings" | "evidence" }>;
type ResultSection = (typeof SCHEMAS)[ResultSchemaId]["sections"][number]
	& Readonly<{ input: FieldDefinition; oneOf?: readonly string[] }>;

export function isResultSchemaId(schemaId: string): schemaId is ResultSchemaId {
	return Object.hasOwn(RESULT_SUPPLEMENTAL_FIELDS, schemaId);
}

function resultSections(schemaId: ResultSchemaId): readonly ResultSection[] {
	return SCHEMAS[schemaId].sections.filter((section): section is ResultSection => section.input !== undefined);
}

function supplementalFields(schemaId: ResultSchemaId): readonly FieldDefinition[] {
	return RESULT_SUPPLEMENTAL_FIELDS[schemaId];
}

function fieldDefinitions(schemaId: ResultSchemaId): readonly FieldDefinition[] {
	return [
		...resultSections(schemaId).map(({ input }) => input),
		...supplementalFields(schemaId),
	];
}

function lineArraySchema(): TSchema {
	return Type.Array(Type.String({ minLength: 1, maxLength: 4000 }));
}

function fieldSchema(section: ResultSection): TSchema {
	const input = section.input;
	switch (input.kind) {
		case "text":
			return Type.String({ minLength: 1, maxLength: 8000 });
		case "choice":
			return Type.String({ minLength: 1, maxLength: 200 });
		case "lines":
			return lineArraySchema();
		case "evidence":
			return Type.Array(Type.String({ pattern: RESULT_EVIDENCE_REFERENCE_PATTERN }));
		case "findings":
			return Type.Array(Type.Object(Object.fromEntries(
				RESULT_FINDING_FIELDS.map((field) => [field, Type.String({ minLength: 1, maxLength: 4000 })]),
			), { additionalProperties: false }));
	}
}

export function resultSubmissionFieldNames(schemaId: ResultSchemaId): readonly string[] {
	return fieldDefinitions(schemaId).map(({ field }) => field);
}

export function resultSubmissionParameters(schemaId: ResultSchemaId): TSchema {
	const sections = resultSections(schemaId);
	const properties: Record<string, TSchema> = Object.fromEntries(sections.map((section) => [section.input.field, fieldSchema(section)]));
	for (const field of supplementalFields(schemaId)) properties[field.field] = field.kind === "evidence"
		? Type.Array(Type.String({ pattern: RESULT_EVIDENCE_REFERENCE_PATTERN }))
		: lineArraySchema();
	return Type.Object(properties, { additionalProperties: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLine(value: unknown, maximumLength = 4000): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength && !/[\r\n]/.test(value);
}

function isEvidenceId(value: unknown): value is string {
	return typeof value === "string" && new RegExp(RESULT_EVIDENCE_REFERENCE_PATTERN).test(value);
}

export function resultSubmissionErrors(schemaId: ResultSchemaId, value: unknown): string[] {
	if (!isRecord(value)) return ["submission must be an object"];
	const definitions = fieldDefinitions(schemaId);
	const expected = new Set(definitions.map(({ field }) => field));
	const errors = Object.keys(value).filter((key) => !expected.has(key)).map((key) => `unknown field: ${key}`);
	for (const definition of definitions) {
		if (!Object.hasOwn(value, definition.field)) {
			errors.push(`${definition.field}: required field is missing`);
			continue;
		}
		const fieldValue = value[definition.field];
		switch (definition.kind) {
			case "text":
				if (!validLine(fieldValue, 8000)) errors.push(`${definition.field}: expected non-empty single-line text`);
				break;
			case "choice": {
				const section = resultSections(schemaId).find((item) => item.input.field === definition.field);
				if (typeof fieldValue !== "string" || fieldValue.length > 200 || !section?.oneOf?.includes(fieldValue)) {
					errors.push(`${definition.field}: expected one of ${section?.oneOf?.join(", ") ?? "the declared choices"}`);
				}
				break;
			}
			case "lines":
				if (!Array.isArray(fieldValue) || fieldValue.some((line) => !validLine(line))) {
					errors.push(`${definition.field}: expected an array of non-empty single-line strings`);
				}
				break;
			case "evidence":
				if (!Array.isArray(fieldValue) || fieldValue.some((id) => !isEvidenceId(id))) {
					errors.push(`${definition.field}: expected an array of local verification evidence IDs`);
				} else if (new Set(fieldValue).size !== fieldValue.length) {
					errors.push(`${definition.field}: duplicate evidence IDs are not allowed`);
				}
				break;
			case "findings":
				if (!Array.isArray(fieldValue)) {
					errors.push(`${definition.field}: expected an array of findings`);
					break;
				}
				fieldValue.forEach((finding, index) => {
					if (!isRecord(finding) || Object.keys(finding).some((key) => !RESULT_FINDING_FIELDS.some((field) => field === key))) {
						errors.push(`${definition.field}[${index}]: expected only ${RESULT_FINDING_FIELDS.join(", ")}`);
						return;
					}
					for (const field of RESULT_FINDING_FIELDS) {
						if (!validLine(finding[field], 4000)) errors.push(`${definition.field}[${index}].${field}: expected non-empty single-line text`);
					}
				});
				break;
		}
	}
	if (errors.length > 0) return errors;
	const proofField = resultSections(schemaId).find((section) => section.input?.kind === "evidence")?.input?.field;
	const observationField = supplementalFields(schemaId).find((field) => field.kind === "evidence")?.field;
	const proofIds = proofField ? listValue(value, proofField) : [];
	const observationIds = observationField ? listValue(value, observationField) : [];
	if (proofIds.some((id) => observationIds.includes(id))) errors.push(`${proofField} and ${observationField} must not overlap`);
	return errors;
}

function listValue(fields: ResultFields, field: string): readonly string[] {
	const value = fields[field];
	return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
}

function textValue(fields: ResultFields, field: string): string {
	const value = fields[field];
	return typeof value === "string" ? value : "";
}

function findingsText(fields: ResultFields, field: string): string[] {
	const value = fields[field];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const location = textValue(item, "location").replaceAll("`", "\\`");
		return [`- \`${location}\` — ${textValue(item, "issue")}. Evidence: ${textValue(item, "evidence")}. Direction: ${textValue(item, "direction")}.`];
	});
}

function sectionBody(schemaId: ResultSchemaId, section: ResultSection, fields: ResultFields, observations: readonly string[]): string[] {
	const input = section.input;
	if (input.kind === "evidence") {
		const proofLines: string[] = [];
		for (const id of listValue(fields, input.field)) {
			const evidence = getVerificationEvidence(id);
			if (evidence?.verifiedBy) proofLines.push(evidence.verifiedBy);
		}
		const notRunField = supplementalFields(schemaId).find((field) => field.kind === "lines")?.field;
		const notRun = notRunField ? listValue(fields, notRunField).map((reason) => `- Not run: ${reason}`) : [];
		if (proofLines.length === 0 && notRun.length === 0) notRun.push("- Not run: no proof IDs submitted");
		return [...proofLines, ...notRun];
	}
	if (input.kind === "findings") {
		const lines = findingsText(fields, input.field);
		return lines.length ? lines : ["None."];
	}
	if (input.kind === "lines") {
		const lines = listValue(fields, input.field);
		return lines.length ? lines.map((line) => `- ${line}`) : ["None."];
	}
	if (input.kind === "text" && section.heading === "Current state" && observations.length > 0) {
		return [textValue(fields, input.field), "", "Verification observations:", ...observations];
	}
	if (input.kind === "choice" || input.kind === "text") return [textValue(fields, input.field)];
	return [];
}

export function renderResultSubmission(schemaId: ResultSchemaId, fields: ResultFields): RenderedResult {
	const errors = resultSubmissionErrors(schemaId, fields);
	if (errors.length > 0) return { text: "", errors };
	const observations: string[] = [];
	const proofField = resultSections(schemaId).find((section) => section.input?.kind === "evidence")?.input?.field;
	const observationField = supplementalFields(schemaId).find((field) => field.kind === "evidence")?.field;
	if (proofField) {
		for (const id of listValue(fields, proofField)) {
			const evidence = getVerificationEvidence(id);
			if (!evidence) errors.push(`${proofField}: evidence ${id} was not found in this child session`);
			else errors.push(...verificationEvidenceErrors(id).map((error) => `${proofField}: ${error}`));
		}
	}
	if (observationField) {
		for (const id of listValue(fields, observationField)) {
			const evidence = getVerificationEvidence(id);
			if (!evidence) {
				errors.push(`${observationField}: evidence ${id} was not found in this child session`);
				continue;
			}
			const evidenceErrors = verificationEvidenceErrors(id);
			const state = evidenceErrors.length === 0 ? "current" : evidenceErrors.some((error) => /stale|obsolete/i.test(error)) ? "stale" : "invalid";
			const reason = evidenceErrors.length === 0 ? "" : `; ${evidenceErrors.join("; ").replace(/[\r\n]/g, " ")}`;
			observations.push(`- Observation \`${id}\`: ${state}, exit ${evidence.exitCode}${reason}.`);
		}
	}
	if (errors.length > 0) return { text: "", errors };
	const sections = resultSections(schemaId);
	const text = sections.flatMap((section) => [
		`## ${section.heading}`,
		...sectionBody(schemaId, section, fields, observations),
		"",
	]).join("\n");
	return { text, errors: [] };
}
