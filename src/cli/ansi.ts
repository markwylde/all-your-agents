const ESC = '\x1b[';

export const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l${ESC}H${ESC}2J`;
export const LEAVE_SCREEN = `${ESC}?25h${ESC}?1049l`;
export const HOME = `${ESC}H`;
export const CLEAR_LINE_END = `${ESC}K`;
export const CLEAR_SCREEN_END = `${ESC}J`;

export type Style = 'bold' | 'dim' | 'inverse' | 'red' | 'yellow' | 'cyan' | 'green';

const CODES: Record<Style, string> = {
	bold: '1',
	dim: '2',
	inverse: '7',
	red: '31',
	green: '32',
	yellow: '33',
	cyan: '36',
};

export function style(text: string, styles: Style[], color: boolean): string {
	if (!color || styles.length === 0 || text === '') return text;
	return `${ESC}${styles.map((s) => CODES[s]).join(';')}m${text}${ESC}0m`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '');
}

/** Replace control characters so untrusted strings cannot move the cursor or inject escapes. */
export function sanitize(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function charWidth(cp: number): number {
	if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

export function width(text: string): number {
	let w = 0;
	for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

/** Cut plain text to at most `max` columns, ending with `…` when cut. */
export function truncate(text: string, max: number): string {
	if (max <= 0) return '';
	if (width(text) <= max) return text;
	let out = '';
	let w = 0;
	for (const ch of text) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** Truncate then pad plain text to exactly `size` columns. */
export function fit(text: string, size: number, align: 'left' | 'right' = 'left'): string {
	const cut = truncate(text, size);
	const pad = ' '.repeat(Math.max(0, size - width(cut)));
	return align === 'right' ? pad + cut : cut + pad;
}
