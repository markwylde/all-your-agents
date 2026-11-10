import type { SqliteRow } from '../../helpers/types.ts';
import type { SessionEvent, TurnFact } from '../../types.ts';
import { MAX_PAYLOAD, terminal } from './data.ts';
import { fields, message, num, str, timestamp } from './protobuf.ts';

/** agy 1.5.5 CortexStep wire fields, checked against its embedded protobuf descriptors. */
export function decodeStep(row: SqliteRow): { events: SessionEvent[]; model?: string } | undefined {
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
		const model = str(message(meta, 24), 8);
		const events: SessionEvent[] = [];
		if (!terminal(row.status) || row.status === 4 || row.status === 5) return { events, model };
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
			if (outcome) events.push({ kind: 'turn-end', outcome, at: end, raw: row });
		} else {
			const tool = message(meta, 4),
				id = str(tool, 1),
				name = str(tool, 2);
			if (id && name) {
				events.push({ kind: 'tool', id, name, at, raw: row });
				events.push({ kind: 'tool-result', id, isError: row.status === 7, at: end, raw: row });
			}
			if (row.step_type === 17)
				events.push({ kind: 'turn-end', outcome: 'failed', at: end, raw: row });
		}
		if ((row.status === 6 || row.status === 12) && !events.some((e) => e.kind === 'turn-end')) {
			events.push({ kind: 'turn-end', outcome: 'interrupted', at: end, raw: row });
		}
		return { events, model };
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
				return [{ type: 'turn-ended', outcome: e.outcome ?? 'completed', endedAt: e.at }];
			default:
				return [];
		}
	});
}
