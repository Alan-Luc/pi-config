import assert from "node:assert/strict";
import { test } from "bun:test";
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
