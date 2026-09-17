import type { SessionStatus } from '../../types.js';

export function mapStatus(word: unknown): { status?: SessionStatus; waitingFor?: string } {
	if (word === 'busy') return { status: 'running' };
	if (word === 'waiting') return { status: 'waiting' };
	if (word === 'idle' || word === 'shell') return { status: 'idle' };
	return {};
}

export function isIdleWord(word: unknown): boolean {
	return word === 'idle' || word === 'shell';
}
