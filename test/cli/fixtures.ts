import type { SessionLike, ViewState } from '../../src/cli/state.js';
import { applyEvent, initialState } from '../../src/cli/state.js';
import type { SessionActivity } from '../../src/index.js';

export const NOW = new Date(2026, 8, 17, 14, 32, 7).getTime();

export function session(id: string, patch: Partial<SessionLike> = {}): SessionLike {
	const activity: SessionActivity = { openSubagents: 0, ...patch.activity };
	return {
		id,
		harness: 'ClaudeCode',
		provider: 'claude-code',
		pid: 1000 + id.charCodeAt(0),
		cwd: `/home/me/${id}`,
		title: `Session ${id}`,
		status: 'idle',
		updatedAt: NOW - 1000,
		...patch,
		activity,
	};
}

export function withSessions(
	sessions: SessionLike[],
	opts: { cols?: number; rows?: number; ready?: boolean } = {},
): ViewState {
	let state = initialState({ cols: opts.cols ?? 120, rows: opts.rows ?? 20 });
	for (const s of sessions)
		state = applyEvent(state, { type: 'session', name: 'create', session: s });
	if (opts.ready !== false) state = applyEvent(state, { type: 'ready', live: sessions });
	return state;
}
