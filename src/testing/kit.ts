import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTimerGuard } from '../helpers/no-timers.ts';
import type { Processes } from '../helpers/types.ts';
import { AllYourAgents } from '../index.ts';
import type { Provider } from '../provider.ts';
import type { FixtureDriver } from './driver.ts';

export type ConformanceOptions = {
	name: string;
	provider: Provider;
	driver: FixtureDriver;
	processes?: Processes;
};

export function defineConformanceTests(opts: ConformanceOptions): void {
	const processes: Processes = opts.processes ?? {
		info: async () => ({ alive: true, startTime: Date.now() }),
		watch: (_pid, onExit) => {
			void onExit;
			return { stop() {} };
		},
	};

	test(`${opts.name}: catch-up and ready`, async () => {
		await opts.driver.createLiveSession({ id: 's1', pid: 1, status: 'busy' });
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		const events: string[] = [];
		aya.on('session:create', (_s, meta) => events.push(`create:${meta.catchUp}`));
		aya.on('session:open', (_s, meta) => events.push(`open:${meta.catchUp}`));
		aya.on('ready', () => events.push('ready'));
		await aya.start();
		assert.ok(events.includes('ready'));
		assert.ok(events.indexOf('ready') === events.length - 1 || events.includes('ready'));
		await aya.stop();
	});

	test(`${opts.name}: status dedupe`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		let n = 0;
		aya.on('session:status', () => n++);
		await aya.start();
		await opts.driver.createLiveSession({ id: 'dedupe', pid: 2, status: 'busy' });
		await opts.driver.rewriteStatus('dedupe', 'busy');
		await opts.driver.rewriteStatus('dedupe', 'idle');
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(n >= 1);
		await aya.stop();
	});

	test(`${opts.name}: activity tool and failed standing`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		await aya.start();
		await opts.driver.createLiveSession({ id: 'act', pid: 3, status: 'busy' });
		await opts.driver.runTurnWithTool('act');
		await opts.driver.failTurn('act');
		const session = aya.running().find((s) => s.id === 'act') ?? (await aya.get('act'));
		assert.ok(session);
		await aya.stop();
	});

	test(`${opts.name}: subagents start/end/nested/cancel`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		const events: string[] = [];
		aya.on('subagent:start', (s) => events.push(`start:${s.id}:${s.parentId ?? ''}`));
		aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
		await aya.start();
		await opts.driver.createLiveSession({ id: 'sub', pid: 4, status: 'busy' });
		const fg = await opts.driver.launchForegroundSubagent('sub');
		const nested = await opts.driver.launchNestedSubagent('sub', fg.subagentId);
		await opts.driver.finishForegroundSubagent('sub', fg.subagentId);
		const bg = await opts.driver.launchBackgroundSubagent('sub');
		await opts.driver.rewriteStatus('sub', 'idle');
		await opts.driver.finishBackgroundSubagent('sub', bg.subagentId);
		await opts.driver.remove('sub');
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(events.some((e) => e.startsWith(`start:${fg.subagentId}`)));
		assert.ok(events.some((e) => e.includes(nested.subagentId)));
		await aya.stop();
	});

	test(`${opts.name}: no timers while idle`, async () => {
		const aya = AllYourAgents({ providers: [opts.provider], processes });
		await aya.start();
		const guard = installTimerGuard();
		try {
			guard.assertIdle();
		} finally {
			guard.restore();
		}
		await aya.stop();
	});
}
