import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	deriveStatus,
	initialEventsState,
	reduceRecord,
} from '../../../src/providers/codex-cli/events.js';
import { lifecycleStatus } from '../../../src/providers/codex-cli/status.js';
import { eventMsg, responseItem } from './home.js';

test('lifecycle mapping never waits', () => {
	assert.equal(lifecycleStatus('task_started'), 'running');
	assert.equal(lifecycleStatus('task_complete'), 'idle');
	assert.equal(lifecycleStatus('turn_aborted'), 'idle');
	assert.equal(lifecycleStatus('item_completed'), undefined);
	assert.equal(lifecycleStatus('exec_approval_request'), undefined);
});

test('settings-only stays idle; open tool stays running without waitingFor', () => {
	const state = initialEventsState();
	reduceRecord(state, eventMsg('thread_settings_applied', { thread_settings: { model: 'x' } }));
	assert.deepEqual(deriveStatus(state), { status: 'idle' });
	reduceRecord(state, eventMsg('task_started'));
	reduceRecord(
		state,
		responseItem({ type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{}' }),
	);
	assert.equal(deriveStatus(state).status, 'running');
	assert.equal('waitingFor' in deriveStatus(state), false);
});

// Codex delivers nothing to an ended turn and persists no in-progress exec state, so a
// unified-exec process that outlives its turn is not a background wait.
test('a unified exec session left running when the turn completes is idle, never waiting', () => {
	const state = initialEventsState();
	reduceRecord(state, eventMsg('task_started'));
	reduceRecord(
		state,
		responseItem({
			type: 'function_call',
			call_id: 'c1',
			name: 'exec_command',
			arguments: JSON.stringify({ cmd: 'npm run dev', yield_time_ms: 1000 }),
		}),
	);
	reduceRecord(
		state,
		responseItem({
			type: 'function_call_output',
			call_id: 'c1',
			output: 'Process running with session ID 7',
		}),
	);
	reduceRecord(state, eventMsg('task_complete'));
	assert.deepEqual(deriveStatus(state), { status: 'idle' });
});
