import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updatesPath } from '../../../src/providers/grok-build/paths.js';
import {
	applyUpdateLines,
	backgroundWait,
	parseUpdateLine,
	type TaskMap,
} from '../../../src/providers/grok-build/updates.js';
import { chunkRow, taskCompletedRow, tasksRow, updateRow } from './home.js';

const text = (...rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

function apply(tasks: TaskMap, ...rows: unknown[]): string[] {
	const failures: string[] = [];
	applyUpdateLines(tasks, text(...rows), (e) => failures.push((e as Error).message));
	return failures;
}

test('updates path', () => {
	assert.equal(updatesPath('/h/sessions/x/id'), '/h/sessions/x/id/updates.jsonl');
});

test('a snapshot replaces the known tasks, keeping kind and status', () => {
	const tasks: TaskMap = new Map();
	assert.deepEqual(apply(tasks, tasksRow(['t1', 'bash', 'running'])), []);
	assert.deepEqual([...tasks], [['t1', { kind: 'bash', status: 'running' }]]);
	assert.equal(backgroundWait(tasks), 'shell');
	apply(tasks, tasksRow(['t2', 'monitor', 'running'], ['t3', 'bash', 'completed']));
	assert.deepEqual(
		[...tasks],
		[
			['t2', { kind: 'monitor', status: 'running' }],
			['t3', { kind: 'bash', status: 'completed' }],
		],
	);
	assert.equal(backgroundWait(tasks), 'monitor');
	apply(tasks, tasksRow(['t2', 'monitor', 'failed']));
	assert.equal(backgroundWait(tasks), undefined);
	apply(tasks, tasksRow());
	assert.equal(tasks.size, 0);
});

test('a completion ends the task it names and no other', () => {
	const tasks: TaskMap = new Map();
	apply(tasks, tasksRow(['t1', 'bash', 'running'], ['t2', 'monitor', 'running']));
	assert.deepEqual(apply(tasks, taskCompletedRow('t2', 1)), []);
	assert.equal(backgroundWait(tasks), 'shell');
	assert.deepEqual(apply(tasks, taskCompletedRow('unknown')), []);
	apply(tasks, taskCompletedRow('t1'));
	assert.equal(backgroundWait(tasks), undefined);
	assert.equal(tasks.size, 2);
});

test('chunk rows and other rows are ignored without a failure, before being parsed', () => {
	const tasks: TaskMap = new Map();
	apply(tasks, tasksRow(['t1', 'monitor', 'running']));
	const failures = apply(
		tasks,
		chunkRow('agent_message_chunk'),
		chunkRow('agent_thought_chunk'),
		chunkRow('user_message_chunk'),
		chunkRow('tool_call'),
		chunkRow('tool_call_update'),
		chunkRow('plan'),
		// Prose that quotes a task row is still a chunk.
		chunkRow('agent_message_chunk', JSON.stringify(tasksRow())),
		updateRow({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
		updateRow({ sessionUpdate: 'task_backgrounded', task_id: 't9' }),
	);
	assert.deepEqual(failures, []);
	assert.equal(backgroundWait(tasks), 'monitor');
	assert.equal(tasks.size, 1);
	// Not JSON at all: never parsed, because it cannot be one of Grok's own rows.
	assert.equal(parseUpdateLine('{"method":"session/update", torn'), undefined);
	assert.equal(parseUpdateLine('{"method":"_x.ai/session/update","params":{"upd'), undefined);
	assert.equal(parseUpdateLine(''), undefined);
});

test('a background_tasks row without tasks is a failure and keeps the known tasks', () => {
	const tasks: TaskMap = new Map();
	apply(tasks, tasksRow(['t1', 'bash', 'running']));
	const failures = apply(
		tasks,
		updateRow({ sessionUpdate: 'background_tasks' }),
		updateRow({ sessionUpdate: 'background_tasks', tasks: 'none' }),
		updateRow({ sessionUpdate: 'task_completed', task_snapshot: {} }),
	);
	assert.equal(failures.length, 3);
	assert.match(failures[0] ?? '', /background_tasks/);
	assert.deepEqual([...tasks], [['t1', { kind: 'bash', status: 'running' }]]);
	// Rows after a bad one are still applied.
	assert.deepEqual(
		apply(tasks, updateRow({ sessionUpdate: 'background_tasks' }), taskCompletedRow('t1')).length,
		1,
	);
	assert.equal(backgroundWait(tasks), undefined);
});
