// Stream changes to agent sessions as they happen. Ctrl+C to stop.
//
//   node ./demo/watch.ts

import AllYourAgents, { type EventMeta, type Session } from '../src/index.ts';

const aya = AllYourAgents();

const stamp = () => new Date().toLocaleTimeString();
const who = (s: Session) => `${s.id.slice(0, 8)} ${s.title ?? s.cwd ?? ''}`.trim();
const log = (event: string, text: string, meta?: EventMeta) =>
	console.log(`${stamp()}  ${meta?.catchUp ? '(catch-up) ' : ''}${event.padEnd(16)} ${text}`);

aya.on('session:create', (s, meta) => log('create', `${who(s)}  pid ${s.pid}`, meta));
aya.on('session:open', (s, meta) => log('open', `${who(s)}  pid ${s.pid}`, meta));
aya.on('session:status', (s, meta) =>
	log('status', `${who(s)}  → ${s.status}${s.waitingFor ? ` (${s.waitingFor})` : ''}`, meta),
);
// Fires when the effective title, cwd, or model changes.
aya.on('session:update', (s, meta) =>
	log(
		'update',
		`${s.id.slice(0, 8)} title=${s.title ?? '-'} cwd=${s.cwd ?? '-'} model=${s.model ?? '-'}`,
		meta,
	),
);
aya.on('session:activity', (s, meta) => {
	const a = s.activity;
	const detail = a.tool
		? `using ${a.tool.name}`
		: a.lastTurn
			? `turn ${a.lastTurn}${a.error ? `: ${a.error}` : ''}`
			: 'working';
	log('activity', `${who(s)}  ${detail}`, meta);
});
aya.on('session:close', (s, meta) => log('close', who(s), meta));
aya.on('subagent:start', (sub, s, meta) =>
	log('subagent:start', `${who(s)}  ${sub.type}${sub.title ? `: ${sub.title}` : ''}`, meta),
);
aya.on('subagent:end', (sub, s, meta) =>
	log('subagent:end', `${who(s)}  ${sub.type} ${sub.status}`, meta),
);
aya.on('ready', () => log('ready', `${aya.running().length} live, watching for changes…`));
aya.on('error', (e) => log('error', `${e.provider}: ${String(e.error)}`));

process.once('SIGINT', async () => {
	await aya.stop();
	process.exit(0);
});

await aya.start();
