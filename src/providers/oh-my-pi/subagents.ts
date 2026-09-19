import { basename, join } from 'node:path';
import type { Fs } from '../../helpers/types.ts';
import type { SubagentFacts, SubagentStatus } from '../../types.ts';
import { entryOf } from './events.ts';
import { asyncAgentIds, childHistory, readRecords, reportedOutcomes } from './journal.ts';
import { artifactDir } from './paths.ts';
import { readHead } from './session-file.ts';

const HARNESS = 'OhMyPi';

type Ended = Exclude<SubagentStatus, 'running'>;

/** Tool logs, subagent outputs and sidecars that sit beside subagent transcripts. */
export const NOT_A_DIRECTORY = /\.(md|log|json|jsonl|tmp|lock|os)$/;

/** omp's own id for a subagent is its transcript's name: `PowTwoTen`, `NestParent.MulChild`. */
export const agentIdOf = (path: string): string => basename(path).slice(0, -'.jsonl'.length);

/** `NestParent.MulChild` is titled `MulChild`. */
export const agentTitleOf = (id: string): string => id.slice(id.lastIndexOf('.') + 1);

/** Every subagent transcript under an artifact directory, nested ones included. */
export async function childFiles(fs: Fs, dir: string): Promise<string[]> {
	const out: string[] = [];
	let names: string[] = [];
	try {
		names = await fs.readDir(dir);
	} catch {
		return out;
	}
	for (const name of names.sort()) {
		const path = join(dir, name);
		if (name.endsWith('.jsonl')) out.push(path);
		else if (!NOT_A_DIRECTORY.test(name) && (await fs.stat(path).catch(() => null))?.isDirectory) {
			out.push(...(await childFiles(fs, path)));
		}
	}
	return out;
}

/**
 * What the parents' transcripts say about their agents: which were spawned asynchronously,
 * and how each ended, with the earliest report kept, as the live path keeps the first.
 */
async function parentReports(
	fs: Fs,
	paths: string[],
): Promise<{ background: Set<string>; reported: Map<string, { status: Ended; at?: number }> }> {
	const background = new Set<string>();
	const reported = new Map<string, { status: Ended; at?: number }>();
	for (const path of paths) {
		for (const rec of await readRecords(fs, path).catch(() => [])) {
			for (const id of asyncAgentIds(rec)) background.add(id);
			const at = entryOf(rec)?.at;
			for (const { id, status } of reportedOutcomes(rec)) {
				const known = reported.get(id);
				if (!known || (at != null && known.at != null && at < known.at)) {
					reported.set(id, { status, at });
				}
			}
		}
	}
	return { background, reported };
}

/**
 * A finished session's subagents from disk alone. A child's end is whichever came first,
 * its own transcript's or its parent's report; one with neither was cut off.
 */
export async function subagentsOnDisk(
	fs: Fs,
	sessionPath: string,
	sessionId: string,
): Promise<SubagentFacts[]> {
	const dir = artifactDir(sessionPath);
	if (!dir) return [];
	const files = await childFiles(fs, dir);
	const { background, reported } = await parentReports(fs, [sessionPath, ...files]);
	const out: SubagentFacts[] = [];
	for (const path of files) {
		const id = agentIdOf(path);
		const head = await readHead(fs, path);
		const own = await childHistory(fs, path);
		const told = reported.get(id);
		const end =
			own.status && !(told?.at != null && own.endedAt != null && told.at < own.endedAt)
				? { status: own.status, at: own.endedAt }
				: (told ?? { status: 'cancelled' as const });
		const facts: SubagentFacts = {
			id,
			sessionId,
			harness: HARNESS,
			type: own.type ?? 'subagent',
			title: agentTitleOf(id),
			background: background.has(id),
			status: end.status,
		};
		const parent = head?.parentSession;
		if (parent && files.some((file) => basename(file) === basename(parent))) {
			facts.parentId = agentIdOf(parent);
		}
		if (head?.startedAt != null) facts.startedAt = head.startedAt;
		if (end.at != null) facts.endedAt = end.at;
		out.push(facts);
	}
	return out;
}
