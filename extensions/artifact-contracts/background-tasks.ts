import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_TASK_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BACKGROUND_TASK_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BACKGROUND_TASK_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
export const BACKGROUND_TASK_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
export const BACKGROUND_TASK_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
export const BACKGROUND_TASK_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const TASK_KEYS = [
	"id", "name", "command", "description", "status", "outputPath", "cwd", "startTime", "endTime",
	"exitCode", "signal", "pid", "bytesWritten", "isAgent", "surviveReload", "reloadSurvival", "error",
	"notified", "notifyOnCompletion", "triggerOnCompletion", "timeoutSeconds", "contextUsage", "tokenUsage",
	"toolUsage", "model", "telemetryUnavailableReason", "shellPolicy",
] as const;

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export type BackgroundTaskSnapshot = Readonly<{
	id: string;
	name?: string;
	command: string;
	status: BackgroundTaskStatus;
	outputPath: string;
	cwd: string;
	startTime: number;
	endTime?: number;
	exitCode?: number | null;
	signal?: string | null;
	bytesWritten: number;
	isAgent: boolean;
	error?: string;
	notified: boolean;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	timeoutSeconds?: number;
}>;

export type BackgroundTaskCapabilities = Readonly<{
	api_version: 1;
	run: true;
	run_is_agent: true;
	run_completion_trigger: true;
	status: true;
	logs: true;
	logs_bounded: true;
	kill: true;
}>;

export type BackgroundTaskRunPayload = Readonly<{
	name: string;
	command: string;
	isAgent: boolean;
	timeoutSeconds?: number;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
}>;

export type BackgroundTaskStatusPayload = Readonly<{ taskId?: string }>;
export type BackgroundTaskLogsPayload = Readonly<{ taskId: string; maxBytes?: number; tail?: boolean }>;
export type BackgroundTaskKillPayload = Readonly<{ taskId: string }>;

export type BackgroundTaskStatusResult = Readonly<{ tasks: readonly BackgroundTaskSnapshot[] }>;
export type BackgroundTaskLogsResult = Readonly<{
	task: BackgroundTaskSnapshot;
	path: string;
	bytesRead: number;
	truncated: boolean;
	tail: boolean;
	text: string;
}>;
export type BackgroundTaskKillResult = Readonly<{ task: BackgroundTaskSnapshot; message: string }>;
export type BackgroundTaskResult =
	| BackgroundTaskCapabilities
	| BackgroundTaskSnapshot
	| BackgroundTaskStatusResult
	| BackgroundTaskLogsResult
	| BackgroundTaskKillResult;

export type BackgroundTaskOperation = "capabilities" | "run" | "status" | "logs" | "kill";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function assertClosed(record: JsonRecord, allowed: readonly string[], label: string): void {
	const keys = new Set(allowed);
	for (const key of Object.keys(record)) if (!keys.has(key)) throw new Error(`${label} contains unknown key ${key}`);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function requireText(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
	return value;
}

function optionalNullableNumber(value: unknown, label: string): number | null | undefined {
	if (value === undefined || value === null) return value;
	return requireNumber(value, label);
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
	if (value === undefined || value === null) return value;
	return requireString(value, label);
}

function taskStatus(value: unknown): BackgroundTaskStatus {
	if (value === "running" || value === "completed" || value === "failed" || value === "killed") return value;
	throw new Error("background task status must be running, completed, failed, or killed");
}

export function parseBackgroundTaskSnapshot(value: unknown): BackgroundTaskSnapshot {
	const task = requireRecord(value, "background task");
	assertClosed(task, TASK_KEYS, "background task");
	return {
		id: requireString(task.id, "background task.id"),
		...(task.name === undefined ? {} : { name: requireString(task.name, "background task.name") }),
		command: requireString(task.command, "background task.command"),
		status: taskStatus(task.status),
		outputPath: requireString(task.outputPath, "background task.outputPath"),
		cwd: requireString(task.cwd, "background task.cwd"),
		startTime: requireNumber(task.startTime, "background task.startTime"),
		...(task.endTime === undefined ? {} : { endTime: requireNumber(task.endTime, "background task.endTime") }),
		...(task.exitCode === undefined ? {} : { exitCode: optionalNullableNumber(task.exitCode, "background task.exitCode") }),
		...(task.signal === undefined ? {} : { signal: optionalNullableString(task.signal, "background task.signal") }),
		bytesWritten: requireNumber(task.bytesWritten, "background task.bytesWritten"),
		isAgent: requireBoolean(task.isAgent, "background task.isAgent"),
		...(task.error === undefined ? {} : { error: requireString(task.error, "background task.error") }),
		notified: requireBoolean(task.notified, "background task.notified"),
		notifyOnCompletion: requireBoolean(task.notifyOnCompletion, "background task.notifyOnCompletion"),
		triggerOnCompletion: requireBoolean(task.triggerOnCompletion, "background task.triggerOnCompletion"),
		...(task.timeoutSeconds === undefined ? {} : { timeoutSeconds: requireNumber(task.timeoutSeconds, "background task.timeoutSeconds") }),
	};
}

function parseCapabilities(value: unknown): BackgroundTaskCapabilities {
	const result = requireRecord(value, "background task capabilities");
	const keys = ["api_version", "run", "run_is_agent", "run_completion_trigger", "status", "logs", "logs_bounded", "kill"];
	assertClosed(result, keys, "background task capabilities");
	if (
		result.api_version !== 1 || result.run !== true || result.run_is_agent !== true
		|| result.run_completion_trigger !== true || result.status !== true || result.logs !== true
		|| result.logs_bounded !== true || result.kill !== true
	) throw new Error("pi-background-tasks EventBus v1 lacks required capabilities");
	return {
		api_version: 1,
		run: true,
		run_is_agent: true,
		run_completion_trigger: true,
		status: true,
		logs: true,
		logs_bounded: true,
		kill: true,
	};
}

function parseOperationResult(operation: BackgroundTaskOperation, value: unknown): BackgroundTaskResult {
	if (operation === "capabilities") return parseCapabilities(value);
	if (operation === "run") return parseBackgroundTaskSnapshot(value);
	const result = requireRecord(value, `background task ${operation} result`);
	if (operation === "status") {
		assertClosed(result, ["tasks"], "background task status result");
		if (!Array.isArray(result.tasks)) throw new Error("background task status result.tasks must be an array");
		return { tasks: result.tasks.map(parseBackgroundTaskSnapshot) };
	}
	if (operation === "logs") {
		assertClosed(result, ["task", "path", "bytesRead", "truncated", "tail", "text"], "background task logs result");
		return {
			task: parseBackgroundTaskSnapshot(result.task),
			path: requireString(result.path, "background task logs result.path"),
			bytesRead: requireNumber(result.bytesRead, "background task logs result.bytesRead"),
			truncated: requireBoolean(result.truncated, "background task logs result.truncated"),
			tail: requireBoolean(result.tail, "background task logs result.tail"),
			text: requireText(result.text, "background task logs result.text"),
		};
	}
	assertClosed(result, ["task", "message"], "background task kill result");
	return {
		task: parseBackgroundTaskSnapshot(result.task),
		message: requireString(result.message, "background task kill result.message"),
	};
}

export function onBackgroundTaskTerminal(
	events: EventBus,
	listener: (task: BackgroundTaskSnapshot) => void,
): () => void {
	return events.on(BACKGROUND_TASK_TERMINAL_CHANNEL, (value) => {
		const terminal = requireRecord(value, "background task terminal frame");
		assertClosed(terminal, ["schema_version", "task"], "background task terminal frame");
		if (terminal.schema_version !== BACKGROUND_TASK_TERMINAL_SCHEMA) throw new Error("background task terminal schema_version mismatch");
		const task = parseBackgroundTaskSnapshot(terminal.task);
		if (task.status === "running") throw new Error("background task terminal frame cannot contain a running task");
		listener(task);
	});
}

export function requestBackgroundTask(
	events: EventBus,
	operation: "capabilities",
	payload: Record<PropertyKey, never>,
	timeoutMs?: number,
): Promise<BackgroundTaskCapabilities>;
export function requestBackgroundTask(
	events: EventBus,
	operation: "run",
	payload: BackgroundTaskRunPayload,
	timeoutMs?: number,
): Promise<BackgroundTaskSnapshot>;
export function requestBackgroundTask(
	events: EventBus,
	operation: "status",
	payload: BackgroundTaskStatusPayload,
	timeoutMs?: number,
): Promise<BackgroundTaskStatusResult>;
export function requestBackgroundTask(
	events: EventBus,
	operation: "logs",
	payload: BackgroundTaskLogsPayload,
	timeoutMs?: number,
): Promise<BackgroundTaskLogsResult>;
export function requestBackgroundTask(
	events: EventBus,
	operation: "kill",
	payload: BackgroundTaskKillPayload,
	timeoutMs?: number,
): Promise<BackgroundTaskKillResult>;
export function requestBackgroundTask(
	events: EventBus,
	operation: BackgroundTaskOperation,
	payload: object,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<BackgroundTaskResult> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("background task request timeout must be positive");
	const requestId = `artifact-contracts-${randomUUID()}`;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
			action();
		};
		const unsubscribe = events.on(BACKGROUND_TASK_RESPONSE_CHANNEL, (value) => {
			if (!isRecord(value) || value.request_id !== requestId) return;
			try {
				assertClosed(value, value.ok === true
					? ["schema_version", "request_id", "operation", "ok", "result"]
					: ["schema_version", "request_id", "operation", "ok", "error"], "background task response frame");
				if (value.schema_version !== BACKGROUND_TASK_RESPONSE_SCHEMA) throw new Error("background task response schema_version mismatch");
				if (value.operation !== operation) throw new Error("background task response operation mismatch");
				if (value.ok === false) throw new Error(`pi-background-tasks ${operation} failed: ${requireString(value.error, "background task response.error")}`);
				if (value.ok !== true) throw new Error("background task response ok must be boolean");
				const result = parseOperationResult(operation, value.result);
				finish(() => resolve(result));
			} catch (error) {
				finish(() => reject(error));
			}
		});
		timer = setTimeout(() => finish(() => reject(new Error(`pi-background-tasks ${operation} request timed out`))), timeoutMs);
		try {
			events.emit(BACKGROUND_TASK_REQUEST_CHANNEL, {
				schema_version: BACKGROUND_TASK_REQUEST_SCHEMA,
				request_id: requestId,
				operation,
				payload,
			});
		} catch (error) {
			finish(() => reject(new Error(`pi-background-tasks ${operation} request failed: ${String(error)}`)));
		}
	});
}
