import type { SqliteRow } from '../../helpers/types.ts';
import type { SessionEvent, TurnFact } from '../../types.ts';
import { MAX_PAYLOAD, terminal } from './data.ts';
import { fields, message, num, str, timestamp } from './protobuf.ts';

/** agy 1.5.5 CortexStep wire fields, checked against its embedded protobuf descriptors. */
export function decodeStep(
	row: SqliteRow,
	models = new Map<string, string>(),
):
	| {
			events: SessionEvent[];
			model?: string;
			waitingFor?: string;
			background: boolean;
			backgroundWait?: string;
	  }
	| undefined {
	if (typeof row.legacy_json === 'string') {
		try {
			const log = JSON.parse(row.legacy_json);
			const events: SessionEvent[] = [];
			const parsedAt = typeof log.created_at === 'string' ? Date.parse(log.created_at) : NaN;
			const at = Number.isFinite(parsedAt) ? parsedAt : undefined;
			if (typeof log.content === 'string' && log.content && terminal(row.status)) {
				if (row.step_type === 14) events.push({ kind: 'user', text: log.content, at, raw: log });
				if (row.step_type === 15) {
					events.push({ kind: 'assistant', text: log.content, at, raw: log });
					if (!log.tool_calls?.length && row.status === 3)
						events.push({ kind: 'turn-end', outcome: 'completed', at, raw: log });
				}
			}
			return { events, background: false };
		} catch {
			return;
		}
	}

	if (
		typeof row.idx !== 'number' ||
		!Number.isSafeInteger(row.idx) ||
		row.idx < 0 ||
		row.step_format !== 0 ||
		!(row.step_payload instanceof Uint8Array) ||
		row.step_payload.length > MAX_PAYLOAD
	)
		return;
	try {
		const step = fields(row.step_payload);
		if (num(step, 1) !== row.step_type || num(step, 4) !== row.status) return;
		const meta = message(step, 5);
		const at = timestamp(meta, 1),
			end = timestamp(meta, 8) ?? at;
		const model =
			str(message(meta, 24), 20) ??
			str(message(meta, 24), 8) ??
			models.get(`step:${row.idx}`) ??
			models.get(str(meta, 12) ?? '');
		const task = message(step, 148);
		const background = task.has(8);
		const backgroundWait =
			background && num(task, 6) !== 1 && !terminal(row.status)
				? str(message(meta, 4), 2) === 'run_command'
					? 'shell'
					: 'task'
				: undefined;
		const interaction = message(step, 56);
		const waitingFor =
			row.status !== 9
				? undefined
				: interaction.has(22)
					? 'ask'
					: interaction.has(20)
						? 'elicitation'
						: interaction.size
							? 'approval'
							: undefined;
		const details = { model, waitingFor, background, backgroundWait };
		const events: SessionEvent[] = [];
		if (row.status === 4 || row.status === 5) return { events, ...details };
		const done = terminal(row.status);
		if (!done && (row.step_type === 14 || row.step_type === 15)) return { events, ...details };
		if (row.step_type === 14) {
			const text = str(message(step, 19), 2);
			if (text) events.push({ kind: 'user', text, at, raw: row });
		} else if (row.step_type === 15) {
			const response = message(step, 20);
			const text = str(response, 1);
			if (text) events.push({ kind: 'assistant', text, model, at, raw: row });
			for (const call of response.get(7) ?? []) {
				if (!(call instanceof Uint8Array)) continue;
				const tool = fields(call),
					id = str(tool, 1),
					name = str(tool, 2);
				if (id && name) events.push({ kind: 'tool', id, name, at, raw: row });
			}
			const reason = num(response, 12);
			const outcome =
				row.status === 6 || row.status === 12
					? 'interrupted'
					: row.status === 7
						? 'failed'
						: reason === 2 || reason === 3
							? 'completed'
							: reason === 16
								? 'interrupted'
								: reason === 13 || (reason != null && reason >= 17 && reason <= 20)
									? 'failed'
									: undefined;
			if (outcome && !(response.get(7)?.length && outcome === 'completed'))
				events.push({ kind: 'turn-end', outcome, at: end, raw: row });
		} else {
			const tool = message(meta, 4),
				id = str(tool, 1),
				name = str(tool, 2);
			if (id && name) {
				events.push({ kind: 'tool', id, name, at, raw: row });
				if (done)
					events.push({
						kind: 'tool-result',
						id,
						isError: [6, 7, 12].includes(Number(row.status)),
						at: end,
						raw: row,
					});
			}
			if (row.step_type === 17 && done)
				events.push({ kind: 'turn-end', outcome: 'failed', at: end, raw: row });
		}
		const error = str(message(step, 31), 1) ?? str(message(message(step, 24), 3), 1);
		if (error && done) events.push({ kind: 'error', message: error, at: end, raw: row });
		return { events, ...details };
	} catch {
		return;
	}
}

export function facts(events: SessionEvent[]): TurnFact[] {
	return events.flatMap((e): TurnFact[] => {
		switch (e.kind) {
			case 'user':
				return [{ type: 'turn-started', at: e.at }];
			case 'tool':
				return [{ type: 'tool-started', id: e.id, name: e.name, startedAt: e.at }];
			case 'tool-result':
				return [{ type: 'tool-finished', id: e.id, at: e.at }];
			case 'turn-end':
				return [
					{
						type: 'turn-ended',
						outcome: e.outcome ?? 'completed',
						endedAt: e.at,
						...errorFor(events, e.raw),
					},
				];
			default:
				return [];
		}
	});
}

function errorFor(events: SessionEvent[], raw: unknown): { error?: string } {
	const error = events.find((e) => e.kind === 'error' && e.raw === raw);
	return error?.kind === 'error' ? { error: error.message } : {};
}
