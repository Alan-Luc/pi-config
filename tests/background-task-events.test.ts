import assert from "node:assert/strict";
import { it, test } from "bun:test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	BACKGROUND_TASK_REQUEST_CHANNEL,
	BACKGROUND_TASK_REQUEST_SCHEMA,
	BACKGROUND_TASK_RESPONSE_CHANNEL,
	BACKGROUND_TASK_RESPONSE_SCHEMA,
	BACKGROUND_TASK_TERMINAL_CHANNEL,
	BACKGROUND_TASK_TERMINAL_SCHEMA,
	onBackgroundTaskTerminal,
	requestBackgroundTask,
} from "../extensions/artifact-contracts/background-tasks.ts";

type Listener = (value: unknown) => void;

function eventBus(): EventBus {
	const listeners = new Map<string, Set<Listener>>();
	return {
		on(channel: string, listener: Listener) {
			const channelListeners = listeners.get(channel) ?? new Set<Listener>();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
	} as EventBus;
}

function task(status: "running" | "completed" | "failed" | "killed" = "running") {
	return {
		id: "task-1",
		name: "Verification",
		command: "bun test",
		status,
		outputPath: ".pi/tasks/task-1.output",
		cwd: "/repo",
		startTime: 1,
		...(status === "running" ? {} : { endTime: 2, exitCode: status === "completed" ? 0 : 1 }),
		bytesWritten: 4,
		isAgent: false,
		surviveReload: false,
		notified: status !== "running",
		notifyOnCompletion: true,
		triggerOnCompletion: true,
	};
}

function workStatus() {
	return {
		schema_version: "pi-background-tasks.work-status.v1", version: 1,
		sessionId: "session-1", generation: "generation-1", revision: "a".repeat(64),
		activeAdmissions: 0, shuttingDown: false, taskAdmissionsClosed: false,
		terminalPublicationClosed: false, historyComplete: true, incompletenessReasons: [], tasks: [],
	};
}

it.each([undefined, true, false])("accepts legacy capabilities and additive work_status=%s", async (work_status) => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "capabilities", ok: true,
			result: { api_version: 1, run: true, run_is_agent: true, run_completion_trigger: true,
				status: true, logs: true, logs_bounded: true, kill: true,
				...(work_status === undefined ? {} : { work_status }) },
		});
	});
	const result = await requestBackgroundTask(events, "capabilities", {});
	assert.equal(result.work_status, work_status);
});

test("requests and preserves owner-bound versioned background work status", async () => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		assert.equal(request.operation, "work-status");
		assert.deepEqual(request.payload, { sessionId: "session-1" });
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "work-status", ok: true, result: workStatus(),
		});
	});
	const result = await requestBackgroundTask(events, "work-status", { sessionId: "session-1" });
	assert.equal(result.generation, "generation-1");
	assert.equal(result.revision, "a".repeat(64));
	assert.equal(result.historyComplete, true);
	assert.deepEqual(result.tasks, []);
});

it.each([
	[{ sessionId: "another-session" }, /session/i],
	[{ activeAdmissions: -1 }, /activeAdmissions/],
	[{ activeAdmissions: 0.5 }, /activeAdmissions/],
	[{ historyComplete: true, incompletenessReasons: ["history_pruned"] }, /history|incomplete/i],
	[{ version: 2 }, /version/],
	[{ surprise: true }, /unknown key/],
	[{ revision: 4 }, /revision/],
] as const)("rejects invalid or wrong-owner work status %j", async (overrides, expected) => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "work-status", ok: true, result: { ...workStatus(), ...overrides },
		});
	});
	await assert.rejects(requestBackgroundTask(events, "work-status", { sessionId: "session-1" }), expected);
});

function terminalWorkState() {
	return { task: task("completed"), terminalPublicationState: "delivered", terminalPublished: true,
		terminalPublishInFlight: false, terminalEmitInFlight: false, notificationInFlight: false,
		notificationState: "delivered" };
}

it.each([
	{ terminalPublicationState: "invented" },
	{ terminalPublishInFlight: 0 },
	{ terminalPublicationAbandonReason: "invented" },
	{ extra: true },
])("rejects malformed per-task work facts %j", async (overrides) => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "work-status", ok: true,
			result: { ...workStatus(), tasks: [{ ...terminalWorkState(), ...overrides }] },
		});
	});
	await assert.rejects(requestBackgroundTask(events, "work-status", { sessionId: "session-1" }), /unsupported value|must be boolean|unknown key/);
});

it.each([false, true])("work-status requires a synchronous owner response (late=%s)", async (late) => {
	const events = eventBus();
	if (late) events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		queueMicrotask(() => events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "work-status", ok: true, result: workStatus(),
		}));
	});
	await assert.rejects(requestBackgroundTask(events, "work-status", { sessionId: "session-1" }), /exactly one synchronous owner response/);
});

test("rejects competing work-status owners instead of accepting the first empty snapshot", async () => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		for (const activeAdmissions of [0, 1]) events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "work-status", ok: true,
			result: { ...workStatus(), generation: `owner-${activeAdmissions}`, activeAdmissions },
		});
	});
	await assert.rejects(requestBackgroundTask(events, "work-status", { sessionId: "session-1" }), /owner|ambiguous|exactly one/i);
});

test("rejects duplicate task identities in a work snapshot", async () => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = value as Record<string, unknown>;
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: request.request_id,
			operation: "work-status", ok: true,
			result: { ...workStatus(), tasks: [terminalWorkState(), terminalWorkState()] },
		});
	});
	await assert.rejects(requestBackgroundTask(events, "work-status", { sessionId: "session-1" }), /task ids must be unique/);
});

test("sends a closed v1 request and validates the matching response", async () => {
	const events = eventBus();
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		assert.equal(typeof value, "object");
		if (typeof value !== "object" || value === null) throw new Error("missing request");
		const request = value as Record<string, unknown>;
		assert.equal(request.schema_version, BACKGROUND_TASK_REQUEST_SCHEMA);
		assert.equal(request.operation, "run");
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
			request_id: request.request_id,
			operation: "run",
			ok: true,
			result: task(),
		});
	});
	const result = await requestBackgroundTask(events, "run", {
		name: "Verification",
		command: "bun test",
		isAgent: false,
		notifyOnCompletion: true,
		triggerOnCompletion: true,
	});
	assert.equal(result.id, "task-1");
	assert.equal(result.status, "running");
});

test("rejects matching malformed and service-error responses", async () => {
	for (const response of [
		(requestId: unknown) => ({
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
			request_id: requestId,
			operation: "status",
			ok: true,
			result: { tasks: [task()], extra: true },
		}),
		(requestId: unknown) => ({
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
			request_id: requestId,
			operation: "status",
			ok: false,
			error: "service unavailable",
		}),
	]) {
		const events = eventBus();
		events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
			const request = value as Record<string, unknown>;
			events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, response(request.request_id));
		});
		await assert.rejects(requestBackgroundTask(events, "status", {}), /unknown key extra|service unavailable/);
	}
});

test("delivers only validated terminal task snapshots", () => {
	const events = eventBus();
	const terminal: string[] = [];
	onBackgroundTaskTerminal(events, (snapshot) => terminal.push(`${snapshot.id}:${snapshot.status}`));
	events.emit(BACKGROUND_TASK_TERMINAL_CHANNEL, {
		schema_version: BACKGROUND_TASK_TERMINAL_SCHEMA,
		task: task("completed"),
	});
	assert.deepEqual(terminal, ["task-1:completed"]);
	assert.throws(() => events.emit(BACKGROUND_TASK_TERMINAL_CHANNEL, {
		schema_version: BACKGROUND_TASK_TERMINAL_SCHEMA,
		task: task("running"),
	}), /cannot contain a running task/);
});
