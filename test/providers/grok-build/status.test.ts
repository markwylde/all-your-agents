import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayEvents } from '../../../src/providers/grok-build/activity.js';
import {
	deriveStatus,
	initialEventsState,
	reduceEvent,
} from '../../../src/providers/grok-build/events.js';
import { phaseStatus } from '../../../src/providers/grok-build/status.js';

const phase = (p: string) => ({ type: 'phase_changed', phase: p });

test('phase table', () => {
	for (const p of [
		'waiting_for_model',
		'streaming_text',
		'streaming_reasoning',
		'tool_execution',
	]) {
		assert.equal(phaseStatus(p), 'running', p);
	}
	assert.equal(phaseStatus('permission_prompt'), 'waiting');
	assert.equal(phaseStatus('dreaming'), undefined);
});

test('status from events', () => {
	const status = (records: unknown[]) => deriveStatus(replayEvents(records).state);
	assert.deepEqual(status([]), { status: 'idle' });
	assert.deepEqual(status([{ type: 'turn_started' }]), { status: 'running' });
	assert.deepEqual(status([{ type: 'turn_started' }, phase('streaming_text')]), {
		status: 'running',
	});
	assert.deepEqual(
		status([
			{ type: 'turn_started' },
			phase('permission_prompt'),
			{ type: 'permission_requested', tool_name: 'run_terminal_command' },
		]),
		{ status: 'waiting', waitingFor: 'run_terminal_command' },
	);
	assert.deepEqual(
		status([
			{ type: 'turn_started' },
			phase('permission_prompt'),
			{ type: 'permission_requested', tool_name: 'read_file' },
			{ type: 'permission_resolved', tool_name: 'read_file', decision: 'allow' },
		]),
		{ status: 'running' },
	);
	assert.deepEqual(
		status([{ type: 'turn_started' }, { type: 'turn_ended', outcome: 'completed' }]),
		{
			status: 'idle',
		},
	);
	assert.deepEqual(status([{ type: 'turn_started' }, phase('dreaming')]), {});
	assert.deepEqual(
		status([
			{ type: 'mcp_server_starting' },
			{ type: 'mcp_server_connected' },
			{ type: 'mcp_init_completed' },
		]),
		{ status: 'idle' },
	);
});

test('turn facts', () => {
	const state = initialEventsState();
	assert.deepEqual(reduceEvent(state, { type: 'mcp_init_completed' }), []);
	assert.deepEqual(
		reduceEvent(state, { type: 'turn_started', ts: '2026-01-01T00:00:00Z', model_id: 'grok-4.6' }),
		[{ type: 'turn-started', at: Date.parse('2026-01-01T00:00:00Z') }],
	);
	assert.equal(state.model, 'grok-4.6');
	assert.deepEqual(reduceEvent(state, { type: 'tool_started', tool_name: 'read_file' }), [
		{ type: 'tool-started', id: 'read_file', name: 'read_file', startedAt: undefined },
	]);
	assert.deepEqual(
		reduceEvent(state, {
			type: 'tool_completed',
			tool_name: 'read_file',
			outcome: 'error',
			tool_call_id: 'c1',
		}),
		[{ type: 'tool-finished', id: 'read_file', at: undefined }],
		'a failed tool does not end the turn',
	);
	assert.deepEqual(reduceEvent(state, { type: 'turn_ended', outcome: 'error' }), [
		{ type: 'turn-ended', outcome: 'failed', endedAt: undefined },
	]);
	reduceEvent(state, { type: 'turn_started' });
	assert.deepEqual(reduceEvent(state, { type: 'turn_ended', outcome: 'cancelled' }), [
		{ type: 'turn-ended', outcome: 'interrupted', endedAt: undefined },
	]);
});

test('a tool started after the turn ended is closed at once', () => {
	const { facts, state } = replayEvents([
		{ type: 'turn_started' },
		{ type: 'turn_ended', outcome: 'completed' },
		{ type: 'tool_started', tool_name: 'read_file' },
	]);
	assert.deepEqual(facts.at(-1), {
		type: 'turn-ended',
		outcome: 'interrupted',
		endedAt: undefined,
	});
	assert.equal(deriveStatus(state).status, 'idle');
});
