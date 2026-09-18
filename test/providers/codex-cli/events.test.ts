import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialEventsState, reduceRecord } from '../../../src/providers/codex-cli/events.js';
import { eventMsg, responseItem } from './home.js';

test('task_complete.error fails; turn_aborted interrupts; item_completed is not a tool', () => {
	const state = initialEventsState();
	reduceRecord(state, eventMsg('task_started'));
	const failed = reduceRecord(state, eventMsg('task_complete', { error: { message: 'boom' } }));
	assert.equal(failed[0]?.type, 'turn-ended');
	if (failed[0]?.type === 'turn-ended') {
		assert.equal(failed[0].outcome, 'failed');
		assert.equal(failed[0].error, 'boom');
	}
	reduceRecord(state, eventMsg('task_started'));
	const aborted = reduceRecord(state, eventMsg('turn_aborted', { reason: 'interrupted' }));
	assert.equal(aborted[0]?.type, 'turn-ended');
	assert.equal(aborted[0] && aborted[0].type === 'turn-ended' && aborted[0].outcome, 'interrupted');

	const tools = initialEventsState();
	reduceRecord(tools, eventMsg('task_started'));
	const start = reduceRecord(
		tools,
		responseItem({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: '{}' }),
	);
	reduceRecord(
		tools,
		eventMsg('item_completed', { item: { type: 'CommandExecution', id: 'exec-1' } }),
	);
	reduceRecord(
		tools,
		eventMsg('item_completed', { item: { type: 'CommandExecution', id: 'exec-2' } }),
	);
	const end = reduceRecord(
		tools,
		responseItem({ type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' }),
	);
	assert.equal(start.length, 1);
	assert.equal(end.length, 1);
	assert.equal(tools.openTools.length, 0);
});
