import type { Session, SessionActivity, SessionEvent, Subagent, Turn } from '../../src/index.js';
import AllYourAgents, { builtInProviders, claudeCode } from '../../src/index.js';
import { createMemoryHarness, defineConformanceTests } from '../../src/testing/index.js';

const aya = AllYourAgents({
	providers: [...builtInProviders, claudeCode({ home: '/tmp/claude' })],
	debounce: { quietMs: 25, maxLatencyMs: 1000 },
});

aya.on('session:create', (session: Session) => {
	const activity: SessionActivity = session.activity;
	void activity;
	void session.transcript;
	void session.events;
	void session.subagents;
});

aya.on('session:activity', (session) => {
	void session.activity.lastTurn;
});

void aya.running();
void aya.sessions({ since: 0, kind: 'headless' });
void aya.get('id');
void aya.reconcile(1);

const mem = createMemoryHarness();
defineConformanceTests({ name: 'memory', provider: mem.provider, driver: mem.driver });

type _Turn = Turn;
type _Event = SessionEvent;
type _Sub = Subagent;
void 0 as unknown as _Turn;
void 0 as unknown as _Event;
void 0 as unknown as _Sub;
