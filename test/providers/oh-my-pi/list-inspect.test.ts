import assert from 'node:assert/strict';
import { rename, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import type { Fs } from '../../../src/helpers/types.js';
import { AllYourAgents } from '../../../src/index.js';
import { ohMyPi } from '../../../src/providers/oh-my-pi/index.js';
import type { SessionEvent } from '../../../src/types.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	A,
	appendTranscript,
	artifacts,
	assistant,
	B,
	C,
	fakeOmpProcesses,
	header,
	lines,
	modelChange,
	sessionPath,
	slot,
	user,
	withHome,
	writeTranscript,
} from './home.js';

function counting(): { fs: Fs; bytes: Map<string, number> } {
	const inner = createLocalFs();
	const bytes = new Map<string, number>();
	return {
		bytes,
		fs: {
			...inner,
			readRange: async (p, s, e) => {
				const out = await inner.readRange(p, s, e);
				bytes.set(p, (bytes.get(p) ?? 0) + out.byteLength);
				return out;
			},
		},
	};
}

const observe = (home: string, fs?: Fs) =>
	AllYourAgents({ providers: [ohMyPi({ home })], processes: fakeOmpProcesses(), fs });

test('list: head fields, cwd from the header, slot title without reading the body, subagents excluded', async () => {
	await withHome(async (home) => {
		const big = sessionPath(home, A, '/private/tmp/proj');
		const body: unknown[] = [modelChange('xai-oauth/grok-4.6'), user('the first prompt')];
		for (let i = 0; i < 400; i++)
			body.push(assistant('stop', [{ type: 'text', text: 'x'.repeat(2000) }]), user(`p${i}`));
		body.push(assistant('stop', undefined, { provider: 'anthropic', model: 'opus' }));
		await writeTranscript(big, [
			slot('Lighthouse Keeper Short Story'),
			header(A, { cwd: '/tmp/proj' }, 1_700_000_000_000),
			...body,
		]);
		await writeTranscript(join(artifacts(big), 'PowTwoTen.jsonl'), [
			slot(),
			header(C, { parentSession: big }),
		]);

		const untitled = sessionPath(home, B);
		await writeTranscript(untitled, [
			slot(),
			header(B),
			modelChange('xai-oauth/grok-4.6'),
			user('a prompt as the title'),
		]);
		await writeTranscript(sessionPath(home, C), [slot(), '{broken']);

		const { fs, bytes } = counting();
		const sessions = await observe(home, fs).sessions();
		assert.deepEqual(sessions.map((s) => s.id).sort(), [A, B]);
		const a = sessions.find((s) => s.id === A);
		assert.equal(a?.cwd, '/tmp/proj', 'not the lossy directory name');
		assert.equal(a?.title, 'Lighthouse Keeper Short Story');
		assert.equal(a?.startedAt, 1_700_000_000_000);
		assert.equal(a?.model, 'anthropic/opus', 'the last reply, from a bounded tail');
		assert.equal(a?.kind, undefined, 'omp records nothing that marks a headless run');
		assert.equal(a?.harness, 'OhMyPi');
		assert.ok((bytes.get(big) ?? 0) < 400 * 1024, `read ${bytes.get(big)} of a ~900 KB transcript`);
		const b = sessions.find((s) => s.id === B);
		assert.equal(b?.title, 'a prompt as the title');
		assert.equal(b?.model, 'xai-oauth/grok-4.6');
	});
});

test('list: since short-circuits on mtime before any read', async () => {
	await withHome(async (home) => {
		const old = sessionPath(home, A);
		await writeTranscript(old, [slot(), header(A), user('old')]);
		const lastYear = new Date(Date.now() - 365 * 86400_000);
		await utimes(old, lastYear, lastYear);
		await writeTranscript(sessionPath(home, B), [slot(), header(B), user('new')]);
		const { fs, bytes } = counting();
		const sessions = await observe(home, fs).sessions({ since: Date.now() - 86400_000 });
		assert.deepEqual(
			sessions.map((s) => s.id),
			[B],
		);
		assert.equal(bytes.has(old), false);
	});
});

test('inspect: transcript groups turns; events follow appends, a replace, and stop on close', async () => {
	await withHome(async (home) => {
		const path = sessionPath(home, A);
		await writeTranscript(path, [
			slot(),
			header(A),
			user('one'),
			assistant('stop'),
			user('two'),
			assistant('stop'),
		]);
		const aya = observe(home);
		const session = await aya.get(A);
		assert.ok(session);
		const turns = [];
		for await (const turn of session.transcript()) turns.push(turn);
		assert.deepEqual(
			turns.map((t) => t.outcome),
			['completed', 'completed'],
		);

		const seen: SessionEvent[] = [];
		const stream = session.events();
		const reading = (async () => {
			for await (const event of stream) if (event.kind !== 'other') seen.push(event);
		})();
		await waitFor(() => seen.filter((e) => e.kind === 'user').length === 2);
		await appendTranscript(path, [user('three')]);
		await waitFor(() => seen.filter((e) => e.kind === 'user').length === 3);

		// omp rewrites the file and renames it over the old one. Following survives it.
		const tmp = `${path}.tmp`;
		await writeFile(
			tmp,
			lines([
				slot('T'),
				header(A),
				user('one'),
				assistant('stop'),
				user('two'),
				assistant('stop'),
				user('three'),
			]),
		);
		await rename(tmp, path);
		await sleep(150);
		await appendTranscript(path, [assistant('stop'), user('four')]);
		await waitFor(() => seen.some((e) => e.kind === 'user' && e.text === 'four'));
		assert.equal(seen.filter((e) => e.kind === 'user').length, 4, 'nothing replayed twice');

		stream.close();
		await reading;
	});
});
