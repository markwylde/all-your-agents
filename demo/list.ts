// List every agent session on this machine, live and historical, as a table.
//
//   node ./demo/list.ts
//   node ./demo/list.ts --live

import AllYourAgents, { type Session } from '../src/index.ts';

const liveOnly = process.argv.includes('--live');

const aya = AllYourAgents();

// start() catches up on which sessions have a running process (resolving after
// `ready`); sessions() then merges those with the history each harness left on
// disk. Without start(), sessions() still works but only knows the history.
await aya.start();
const sessions: Session[] = await aya.sessions(liveOnly ? { live: true } : {});
await aya.stop();

sessions.sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));

const time = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '');
const short = (text = '', max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

console.table(
	sessions.map((s) => ({
		status: s.pid ? (s.status ?? 'live') : 'closed',
		pid: s.pid ?? '',
		harness: s.harness,
		title: short(s.title),
		cwd: short(s.cwd?.replace(process.env.HOME ?? '', '~'), 50),
		kind: s.kind ?? '',
		updated: time(s.updatedAt ?? s.startedAt),
	})),
);

console.log(`${sessions.length} sessions, ${sessions.filter((s) => s.pid).length} live`);
