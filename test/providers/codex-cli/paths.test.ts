import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexHome, parseRolloutName } from '../../../src/providers/codex-cli/paths.js';

test('home from option, then CODEX_HOME, then ~/.codex', () => {
	assert.equal(codexHome({ home: '/custom', env: { CODEX_HOME: '/env' } }), '/custom');
	assert.equal(codexHome({ env: { CODEX_HOME: '/env' } }), '/env');
	assert.equal(codexHome({ env: {}, homedir: '/Users/me' }), '/Users/me/.codex');
});

test('parses normal, revert, and zst names', () => {
	const id = '01a086af-479c-7832-974c-7490f99f3a9b';
	const extra = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
	assert.deepEqual(parseRolloutName(`rollout-2026-09-18T12-00-00-${id}.jsonl`), {
		timestamp: '2026-09-18T12-00-00',
		threadId: id,
		rolloutId: id,
		compressed: false,
	});
	assert.equal(parseRolloutName(`rollout-2026-09-18T12-00-00-${id}_${extra}.jsonl`)?.threadId, id);
	assert.equal(
		parseRolloutName(`rollout-2026-09-18T12-00-00-${id}_${extra}.jsonl`)?.rolloutId,
		extra,
	);
	assert.equal(parseRolloutName(`rollout-2026-09-18T12-00-00-${id}.jsonl.zst`)?.compressed, true);
});
