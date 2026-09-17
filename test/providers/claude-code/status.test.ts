import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapStatus } from '../../../src/providers/claude-code/status.js';

test('status mapping table', () => {
	assert.deepEqual(mapStatus('busy'), { status: 'running' });
	assert.deepEqual(mapStatus('waiting'), { status: 'waiting' });
	assert.deepEqual(mapStatus('idle'), { status: 'idle' });
	assert.deepEqual(mapStatus('shell'), { status: 'idle' });
	assert.deepEqual(mapStatus('nope'), {});
	assert.deepEqual(mapStatus(undefined), {});
});
