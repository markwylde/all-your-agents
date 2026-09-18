import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeUtf8 } from '../../../src/helpers/bytes.js';
import {
	acceptMeta,
	parseSessionMeta,
	SESSION_META_MAX_BYTES,
} from '../../../src/providers/codex-cli/session-meta.js';
import { A, sessionMeta } from './home.js';

const bytes = (rec: unknown) => encodeUtf8(`${JSON.stringify(rec)}\n`);

test('parses root, subagent, fork; accepts a resume older than its process', () => {
	const at = Date.now();
	const iso = new Date(at).toISOString();
	const root = parseSessionMeta(bytes(sessionMeta(A, {}, iso)));
	assert.ok(root);
	assert.equal(root.root, true);
	assert.equal(root.kind, 'interactive');
	assert.equal(acceptMeta(root, { alive: true, startTime: at - 1000 }), true);
	assert.equal(acceptMeta(root, { alive: true, startTime: at - 60_000 }), true);
	const skewOk = parseSessionMeta(bytes(sessionMeta(A, {}, new Date(at - 4000).toISOString())));
	assert.ok(skewOk);
	assert.equal(acceptMeta(skewOk, { alive: true, startTime: at }), true);
	const skewBad = parseSessionMeta(bytes(sessionMeta(A, {}, new Date(at - 6000).toISOString())));
	assert.ok(skewBad);
	assert.equal(acceptMeta(skewBad, { alive: true, startTime: at }), true);
	assert.equal(acceptMeta(root, { alive: true, startTime: at + 3_600_000 }), true);
	assert.equal(acceptMeta(root, { alive: false }), false);
	assert.equal(
		parseSessionMeta(
			bytes(
				sessionMeta(A, {
					parent_thread_id: A,
					thread_source: 'subagent',
					source: { subagent: {} },
				}),
			),
		)?.root,
		false,
	);
	assert.equal(parseSessionMeta(bytes(sessionMeta(A, { forked_from_id: A })))?.root, true);
	assert.equal(parseSessionMeta(encodeUtf8('not json\n')), undefined);
	assert.equal(acceptMeta(root, { alive: true }), true);
	assert.equal(parseSessionMeta(bytes(sessionMeta(A, { source: 'exec' })))?.kind, 'headless');
	assert.equal(
		parseSessionMeta(bytes(sessionMeta(A, { originator: 'codex_exec' })))?.kind,
		'headless',
	);
	const oversized = encodeUtf8(`{"pad":"${'x'.repeat(SESSION_META_MAX_BYTES)}"}`);
	assert.ok(oversized.byteLength > SESSION_META_MAX_BYTES);
	assert.equal(parseSessionMeta(oversized), undefined);
});
