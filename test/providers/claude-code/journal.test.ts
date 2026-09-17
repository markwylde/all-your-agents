import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { mapRecord, resolveJournal } from '../../../src/providers/claude-code/journal.js';

test('mapper tables', () => {
	assert.equal(mapRecord({ type: 'user', message: { content: '<system-reminder>x' } }).length, 0);
	assert.equal(
		mapRecord({
			type: 'user',
			origin: { kind: 'task-notification' },
			message: { content: '<task-notification>' },
		}).length,
		0,
	);
	assert.equal(mapRecord({ type: 'queue-operation', content: '<task-notification>' }).length, 0);
	assert.equal(mapRecord({ type: 'custom-title', customTitle: 'iosbugs' })[0]?.kind, 'title');
	assert.equal(mapRecord({ type: 'ai-title', aiTitle: 'hi' })[0]?.kind, 'title');
	assert.equal(mapRecord({ type: 'system', subtype: 'turn_duration' })[0]?.kind, 'turn-end');
	assert.equal(mapRecord({ type: 'relocated' }).length, 0);
	assert.equal(mapRecord({ type: 'worktree-state' }).length, 0);
	assert.equal(mapRecord({ type: 'bridge-session' }).length, 0);
	assert.equal(mapRecord({ type: 'file-history-delta' }).length, 0);
	assert.equal(mapRecord({ type: 'system', subtype: 'compact_boundary' }).length, 0);
	assert.equal(mapRecord({ type: 'system', subtype: 'stop_hook_summary' }).length, 0);
	assert.equal(mapRecord({ type: 'unknown-future' }).length, 0);
	assert.equal(
		mapRecord({ type: 'user', message: { content: [{ type: 'text', text: '<command-name>x' }] } })
			.length,
		0,
	);
	const user = mapRecord({ type: 'user', message: { content: 'hello' } });
	assert.equal(user[0]?.kind, 'user');
});

test('journal resolution: derived, lookup, ambiguity, sidechain', async () => {
	const root = await mkdtemp(join(tmpdir(), 'aya-j-'));
	const fs = createLocalFs();
	const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
	try {
		const a = join(root, 'projects', '-a');
		const b = join(root, 'projects', '-b');
		await mkdir(a, { recursive: true });
		await writeFile(join(a, `${id}.jsonl`), `${JSON.stringify({ sessionId: id, cwd: '/a' })}\n`);
		assert.equal(await resolveJournal(fs, root, id, '/a'), join(a, `${id}.jsonl`));
		assert.equal(await resolveJournal(fs, root, id, '/b'), join(a, `${id}.jsonl`));
		await mkdir(b, { recursive: true });
		await writeFile(join(b, `${id}.jsonl`), `${JSON.stringify({ sessionId: id, cwd: '/b' })}\n`);
		assert.equal(await resolveJournal(fs, root, id, '/z'), undefined);
		const side = join(root, 'projects', '-s');
		await mkdir(side, { recursive: true });
		const sid = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
		await writeFile(
			join(side, `${sid}.jsonl`),
			`${JSON.stringify({ sessionId: sid, isSidechain: true })}\n`,
		);
		assert.equal(await resolveJournal(fs, root, sid), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
