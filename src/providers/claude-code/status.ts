import type { SessionStatus } from '../../types.ts';

export function mapStatus(
	word: unknown,
	waitingFor?: string,
): { status?: SessionStatus; waitingFor?: string } {
	if (word === 'busy') return { status: 'running' };
	if (word === 'waiting')
		return waitingFor ? { status: 'waiting', waitingFor } : { status: 'waiting' };
	// The turn has ended, but a background shell is still running and will wake the session.
	if (word === 'shell') return { status: 'waiting', waitingFor: 'shell' };
	if (word === 'idle') return { status: 'idle' };
	return {};
}

export function isIdleWord(word: unknown): boolean {
	return word === 'idle' || word === 'shell';
}
