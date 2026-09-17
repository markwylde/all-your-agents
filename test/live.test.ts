import { test } from 'node:test';

test('live smoke', async (t) => {
	if (process.env.AYA_LIVE !== '1') {
		t.skip(
			'set AYA_LIVE=1 to start claude and wait for create → status → subagent → activity → close',
		);
		return;
	}
	const { AllYourAgents, builtInProviders } = await import('../src/index.js');
	const aya = AllYourAgents({ providers: [...builtInProviders] });
	const seen = new Set<string>();
	aya.on('session:create', () => seen.add('create'));
	aya.on('session:status', () => seen.add('status'));
	aya.on('subagent:start', () => seen.add('subagent:start'));
	aya.on('subagent:end', () => seen.add('subagent:end'));
	aya.on('session:activity', (s) => {
		if (s.activity.lastTurn === 'completed') seen.add('activity');
	});
	aya.on('session:close', () => seen.add('close'));
	await aya.start();
	const { spawn } = await import('node:child_process');
	const child = spawn('claude', ['-p', 'reply with hi and do not use tools'], { stdio: 'ignore' });
	await new Promise<void>((resolve, reject) => {
		const tmr = setTimeout(() => reject(new Error(`missing ${[...seen]}`)), 60_000);
		const check = (): void => {
			if (seen.has('create') && seen.has('status')) {
				clearTimeout(tmr);
				resolve();
			}
		};
		aya.on('session:status', check);
		child.on('error', reject);
	});
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	await aya.sessions({ since: startOfToday.getTime() });
	await aya.stop();
});
