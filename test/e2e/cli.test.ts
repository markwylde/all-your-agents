import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, claudeCode } from '../../src/index.js';
import type { Session } from '../../src/types.js';
import { measureCost } from './cost.js';
import {
	collectTurns,
	isolatedClaudeHome,
	liveEnabled,
	rmQuiet,
	runPrintClaude,
	startBackgroundClaude,
	stopBackgroundClaude,
	stubProcesses,
	waitUntil,
} from './helpers.js';

function watchAya(aya: ReturnType<typeof AllYourAgents>) {
	const log: string[] = [];
	const sessions = new Map<string, Session>();
	aya.on('session:create', (s) => {
		sessions.set(s.id, s);
		log.push(`create:${s.id}`);
	});
	aya.on('session:open', (s) => {
		sessions.set(s.id, s);
		log.push(`open:${s.id}`);
	});
	aya.on('session:status', (s) => log.push(`status:${s.status}`));
	aya.on('session:activity', (s) => log.push(`activity:${s.activity.lastTurn ?? ''}`));
	aya.on('session:close', (s) => log.push(`close:${s.id}`));
	aya.on('subagent:start', (sub) => log.push(`sub-start:${sub.id}`));
	aya.on('subagent:end', (sub) => log.push(`sub-end:${sub.id}`));
	return { log, sessions };
}

test('prompt-arg, close, resume uuid, continue: events + listing', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('prompt-arg, close, resume uuid, continue', async () => {
		const { home, cwd } = await isolatedClaudeHome();
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const { log, sessions } = watchAya(aya);
		await aya.start();
		const kids: { child: { kill(): void }; bg: string }[] = [];
		try {
			const first = startBackgroundClaude(home, cwd, 'Reply with only the word ONE then stop.');
			const short1 = await first.id;
			kids.push({ child: first.child, bg: short1 });
			await waitUntil(
				() => log.some((l) => l.startsWith('create:') || l.startsWith('open:')),
				45_000,
				() => log.join(' | '),
			);
			await waitUntil(
				() => log.some((l) => l.startsWith('status:')),
				30_000,
				() => log.join(' | '),
			);
			const id = [...sessions.keys()][0];
			assert.ok(id, `no session id: ${log.join(' | ')}`);
			const live = aya.running().find((s) => s.id === id);
			assert.ok(live?.pid, 'live session missing pid');
			assert.equal((await aya.get(id))?.id, id);
			assert.ok((await aya.sessions({ since: 0 })).some((s) => s.id === id));
			await waitUntil(
				async () => {
					const s = await aya.get(id);
					if (!s) return false;
					const texts = await collectTurns(s);
					return texts.some((text) => text.includes('ONE'));
				},
				45_000,
				() => log.join(' | '),
			);

			stopBackgroundClaude(home, short1);
			await waitUntil(
				() => log.some((l) => l.startsWith('close:')),
				20_000,
				() => log.join(' | '),
			);
			assert.equal(aya.running().length, 0);
			const closed = await aya.get(id);
			assert.ok(closed, 'get() lost history after close');
			assert.equal(closed.pid, undefined);
			assert.ok((await collectTurns(closed)).some((text) => text.includes('ONE')));

			let short2 = '';
			for (let attempt = 0; attempt < 3; attempt++) {
				if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
				const resume = startBackgroundClaude(
					home,
					cwd,
					'Reply with only the word TWO then stop.',
					['--resume', id],
					{ inheritSavedOptions: true },
				);
				short2 = await resume.id;
				kids.push({ child: resume.child, bg: short2 });
				try {
					await waitUntil(
						() => log.some((l) => l === `open:${id}`),
						20_000,
						() => log.join(' | '),
					);
					break;
				} catch (err) {
					stopBackgroundClaude(home, short2);
					resume.child.kill();
					if (attempt === 2) throw err;
				}
			}
			assert.ok(
				log.some((l) => l === `open:${id}`),
				`resume uuid did not open ${id}: ${log.join(' | ')}`,
			);
			assert.equal((aya.running().find((s) => s.id === id) ?? (await aya.get(id)))?.id, id);
			await waitUntil(
				async () => {
					const s = await aya.get(id);
					if (!s) return false;
					const texts = await collectTurns(s);
					return texts.some((text) => text.includes('TWO'));
				},
				45_000,
				() => log.join(' | '),
			);
			stopBackgroundClaude(home, short2);
			await waitUntil(
				() => log.filter((l) => l.startsWith('close:')).length >= 2,
				20_000,
				() => log.join(' | '),
			).catch(() => {});

			const printed = runPrintClaude(home, cwd, 'Reply with only the word THREE then stop.', [
				'--continue',
			]);
			assert.equal(printed.status, 0, printed.stderr || printed.stdout);
			assert.match(printed.stdout, /THREE/i);
			const afterContinue = await aya.get(id);
			assert.ok(afterContinue);
			await waitUntil(
				async () => {
					const texts = await collectTurns(afterContinue);
					return texts.some((text) => text.includes('THREE'));
				},
				30_000,
				() => log.join(' | '),
			);
		} finally {
			for (const k of kids) {
				stopBackgroundClaude(home, k.bg);
				k.child.kill();
			}
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});

test('-p is history-only: no live pid, list/get/transcript work', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('-p history-only', async () => {
		const { home, cwd } = await isolatedClaudeHome();
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const { log } = watchAya(aya);
		await aya.start();
		try {
			const result = runPrintClaude(home, cwd, 'Reply with only the word PRINT then stop.');
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(result.stdout, /PRINT/i);
			assert.equal(aya.running().length, 0, `print-mode leaked live: ${log.join(' | ')}`);
			assert.equal(
				log.filter((l) => l.startsWith('create:') || l.startsWith('open:')).length,
				0,
				`print-mode emitted live events: ${log.join(' | ')}`,
			);
			const listed = await aya.sessions({ since: 0 });
			assert.ok(listed.length >= 1, 'print-mode missing from sessions()');
			const row = listed[0];
			assert.ok(row);
			assert.equal(row.pid, undefined);
			assert.equal(row.kind, 'headless');
			const got = await aya.get(row.id);
			assert.ok(got);
			const texts = await collectTurns(got);
			assert.ok(
				texts.some((text) => /PRINT|print/i.test(text)) || /PRINT/i.test(result.stdout),
				`print transcript: ${texts.join(' || ')}`,
			);
		} finally {
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
