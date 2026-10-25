import assert from "node:assert/strict";
import { it, test } from "bun:test";
import { parseTaskSnapshot, TASK_SNAPSHOT_REQUEST, TASK_SNAPSHOT_RESPONSE } from "../extensions/lib/task-snapshot.ts";
import { parseWorkStatusRequest, requestWorkStatus } from "../extensions/lib/work-status.ts";
import type { EventBus } from "@earendil-works/pi-coding-agent";

function snapshot() {
	const blockedBy: string[] = [];
	return {
		version: 1, requestId: "request", sessionId: "native-parent", generation: "producer",
		storeId: "isolated-store", scope: "session-file", revision: "revision-1",
		tasks: [{ id: "1", status: "in_progress", owner: "native-parent", blockedBy }],
		continuation: {
			taskId: "1", disposition: "ready", revision: "revision-1",
			basis: { kind: "request", inputEntryId: "current-human-input", requestEntryId: "original-request" },
		},
	};
}

test("task snapshot query correlates its actual producer and fails closed for foreign or ambiguous replies", () => {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const events: EventBus = {
		on(channel, listener) {
			const handlers = listeners.get(channel) ?? new Set();
			handlers.add(listener);
			listeners.set(channel, handlers);
			return () => { handlers.delete(listener); };
		},
		emit(channel, value) { for (const handler of listeners.get(channel) ?? []) handler(value); },
	};
	assert.equal(requestWorkStatus(events, "tasks", "native-parent"), undefined);
	events.on(TASK_SNAPSHOT_REQUEST, (value) => {
		const request = parseWorkStatusRequest(value);
		if (request?.sessionId === "native-parent") events.emit(TASK_SNAPSHOT_RESPONSE, { ...snapshot(), ...request });
	});
	const reply = requestWorkStatus(events, "tasks", "native-parent");
	assert.ok(reply, "registered task producer must answer on the correlated task channel");
	assert.equal(reply.storeId, "isolated-store");
	assert.equal(requestWorkStatus(events, "tasks", "foreign-parent"), undefined);
	const removeDuplicate = events.on(TASK_SNAPSHOT_REQUEST, (value) => {
		const request = parseWorkStatusRequest(value);
		if (request) events.emit(TASK_SNAPSHOT_RESPONSE, { ...snapshot(), ...request });
	});
	assert.equal(requestWorkStatus(events, "tasks", "native-parent"), undefined);
	removeDuplicate();
});

test("task snapshot is a detached typed wire observation, not an approval grant", () => {
	const input = snapshot();
	const parsed = parseTaskSnapshot(input);
	assert.ok(parsed);
	assert.equal(parsed.scope, "session-file");
	assert.equal(parsed.continuation?.basis.inputEntryId, "current-human-input");
	input.tasks[0].blockedBy.push("foreign");
	assert.deepEqual(parsed.tasks[0].blockedBy, []);
	assert.equal(parseTaskSnapshot({ ...snapshot(), continuation: null })?.continuation, null);
});

it.each([
	{ name: "unknown version", change: { version: 2 } },
	{ name: "shared store", change: { scope: "project" } },
	{ name: "memory store", change: { scope: "memory" } },
	{ name: "missing store", change: { storeId: "" } },
	{ name: "unscoped metadata", change: { metadata: { approved: true } } },
	{ name: "untyped disposition", change: { continuation: { approved: true } } },
	{ name: "duplicate IDs", change: { tasks: [{ id: "1", status: "pending", blockedBy: [] }, { id: "1", status: "completed", blockedBy: [] }] } },
	{ name: "task prompt leakage", change: { tasks: [{ id: "1", status: "pending", blockedBy: [], description: "private prompt" }] } },
	{ name: "unknown task status", change: { tasks: [{ id: "1", status: "approved", blockedBy: [] }] } },
	{ name: "duplicate dependency", change: { tasks: [{ id: "1", status: "pending", blockedBy: ["2", "2"] }] } },
])("task snapshot rejects $name", ({ change }) => {
	assert.equal(parseTaskSnapshot({ ...snapshot(), ...change }), undefined);
});

test("plan continuation basis needs canonical source and explicit provenance references", () => {
	const input = snapshot();
	const basis = {
		kind: "plan", inputEntryId: "current-human-input", requestEntryId: "original-request",
		plan: ".harness/plans/2026-10-24-workflow.md", decisionAnchor: "approve-tech-lead", approvalEntryId: "actual-human-approval",
	};
	assert.ok(parseTaskSnapshot({ ...input, continuation: { ...input.continuation, basis } }));
	for (const invalid of [
		{ ...basis, plan: "../foreign.md" }, { ...basis, approvalEntryId: "" },
		{ ...basis, decisionAnchor: "" }, { ...basis, approved: true },
	]) assert.equal(parseTaskSnapshot({ ...input, continuation: { ...input.continuation, basis: invalid } }), undefined);
});
