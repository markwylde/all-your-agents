import type { Key } from './state.ts';

export type ReadlineKey = {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
	sequence?: string;
};

const NAMED: Record<string, Key> = {
	up: 'up',
	down: 'down',
	home: 'home',
	end: 'end',
	pageup: 'pageup',
	pagedown: 'pagedown',
	return: 'enter',
	enter: 'enter',
	escape: 'escape',
	backspace: 'backspace',
};

/** Map a `readline` keypress to a view key, or undefined for keys the view ignores. */
export function toKey(str: string | undefined, key: ReadlineKey | undefined): Key | undefined {
	if (key?.ctrl && key.name === 'c') return 'ctrl-c';
	// Node reports a lone Esc as `{ name: 'escape', meta: true }`, so named keys are
	// matched before modified keys are dropped.
	if (key?.name && NAMED[key.name]) return NAMED[key.name];
	if (key?.ctrl || key?.meta) return undefined;
	const ch = str ?? key?.sequence;
	if (ch && ch.length > 0 && [...ch].length === 1 && ch >= ' ' && ch !== '\x7f')
		return { char: ch };
	return undefined;
}
