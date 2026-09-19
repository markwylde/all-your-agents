// Renders the README compatibility matrix to docs/images/compatibility.svg.
// Edit AGENTS / FEATURES / MATRIX below, then run: node scripts/render-compat.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = ['Claude Code', 'Grok Build', 'Codex CLI', 'oh-my-pi'];

// One entry per feature; one cell per agent. F = full, P = partial, N = none.
// A number after the letter is the README footnote for that cell.
const MATRIX = [
	['Live detection', 'F', 'F', 'F', 'F'],
	['Status', 'F', 'F', 'F', 'F6'],
	['Waiting for', 'F', 'F', 'N5', 'P7'],
	['Titles', 'F', 'F', 'F', 'F'],
	['Model', 'F', 'F', 'F', 'F'],
	['Tools', 'F', 'P2', 'F', 'F'],
	['Turn outcome', 'F', 'P3', 'F', 'F'],
	['Subagents', 'F', 'F', 'F', 'F'],
	['Transcript', 'F', 'F', 'F', 'F'],
	['History', 'F', 'F', 'F', 'F'],
	['Print mode', 'P1', 'P4', 'F', 'P8'],
];

const LABEL_W = 176;
const COL_W = 124;
const HEAD_H = 52;
const ROW_H = 36;
const LEGEND_H = 48;
const PAD = 1;
const R = 6.5;

const width = LABEL_W + COL_W * AGENTS.length + PAD * 2;
const tableH = HEAD_H + ROW_H * MATRIX.length;
const height = tableH + LEGEND_H + PAD * 2;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function mark(kind, cx, cy) {
	if (kind === 'F') return `<circle class="full" cx="${cx}" cy="${cy}" r="${R}"/>`;
	if (kind === 'P') {
		return (
			`<circle class="part-ring" cx="${cx}" cy="${cy}" r="${R - 0.75}"/>` +
			`<path class="part" d="M${cx} ${cy - R}A${R} ${R} 0 0 0 ${cx} ${cy + R}Z"/>`
		);
	}
	return `<circle class="none" cx="${cx}" cy="${cy}" r="${R - 0.75}"/>`;
}

const out = [];
out.push(
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t">`,
	'<title id="t">Compatibility of each agent with each all-your-agents feature</title>',
	`<style>
  svg { --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --band:#f6f8fa; --head:#f6f8fa;
        --full:#1a7f37; --part:#bf8700; --none:#cf222e; }
  @media (prefers-color-scheme: dark) {
    svg { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --band:#151b23; --head:#151b23;
          --full:#3fb950; --part:#d29922; --none:#f85149; }
  }
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; fill: var(--fg); }
  .agent { font-size: 13px; font-weight: 600; }
  .feat { font-size: 13px; }
  .note { font-size: 10px; font-weight: 600; fill: var(--muted); }
  .legend { font-size: 12px; fill: var(--muted); }
  .card { fill: var(--bg); stroke: var(--line); }
  .rule { stroke: var(--line); }
  .band { fill: var(--band); }
  .head { fill: var(--head); }
  .full { fill: var(--full); }
  .part { fill: var(--part); }
  .part-ring { fill: none; stroke: var(--part); stroke-width: 1.5; }
  .none { fill: none; stroke: var(--none); stroke-width: 1.5; }
</style>`,
);

const x0 = PAD;
const y0 = PAD;
out.push(`<g transform="translate(${x0} ${y0})">`);

// Card background, header band, alternating row bands. The card paints its own
// background so the theme's text colours never land on the other theme's page.
const cardW = width - PAD * 2;
const cardH = tableH + LEGEND_H;
out.push(`<rect class="card" width="${cardW}" height="${cardH}" rx="6"/>`);
out.push(`<clipPath id="c"><rect width="${cardW}" height="${cardH}" rx="6"/></clipPath>`);
out.push('<g clip-path="url(#c)">');
out.push(`<rect class="head" width="${width - PAD * 2}" height="${HEAD_H}"/>`);
MATRIX.forEach((_, i) => {
	if (i % 2 === 1)
		out.push(
			`<rect class="band" y="${HEAD_H + i * ROW_H}" width="${width - PAD * 2}" height="${ROW_H}"/>`,
		);
});
out.push('</g>');
out.push(`<line class="rule" x1="0" x2="${cardW}" y1="${HEAD_H}" y2="${HEAD_H}"/>`);
out.push(`<line class="rule" x1="0" x2="${cardW}" y1="${tableH}" y2="${tableH}"/>`);
out.push(`<rect class="card" style="fill:none" width="${cardW}" height="${cardH}" rx="6"/>`);

AGENTS.forEach((name, j) => {
	const cx = LABEL_W + COL_W * j + COL_W / 2;
	out.push(
		`<text class="agent" x="${cx}" y="${HEAD_H / 2 + 4.5}" text-anchor="middle">${esc(name)}</text>`,
	);
});

MATRIX.forEach(([feature, ...cells], i) => {
	const cy = HEAD_H + i * ROW_H + ROW_H / 2;
	out.push(`<text class="feat" x="16" y="${cy + 4.5}">${esc(feature)}</text>`);
	cells.forEach((cell, j) => {
		const cx = LABEL_W + COL_W * j + COL_W / 2;
		out.push(mark(cell[0], cx, cy));
		const note = cell.slice(1);
		if (note) out.push(`<text class="note" x="${cx + R + 4}" y="${cy - 2}">${note}</text>`);
	});
});

// Legend.
const ly = tableH + LEGEND_H / 2;
let lx = 16;
for (const [kind, label, w] of [
	['F', 'Full', 60],
	['P', 'Partial', 76],
	['N', 'None', 64],
]) {
	out.push(mark(kind, lx + R, ly));
	out.push(`<text class="legend" x="${lx + R * 2 + 7}" y="${ly + 4}">${label}</text>`);
	lx += w;
}
out.push(
	`<text class="legend" x="${width - PAD * 2 - 16}" y="${ly + 4}" text-anchor="end">Numbers refer to the notes below.</text>`,
);

out.push('</g></svg>');

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', 'docs', 'images', 'compatibility.svg');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${out.join('\n')}\n`);
console.log(`wrote ${file}`);
