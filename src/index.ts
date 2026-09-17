import type { AllYourAgents as Instance } from './core/instance.ts';
import { createAllYourAgents } from './core/instance.ts';
import type { InstanceOptions } from './provider.ts';
import { claudeCode } from './providers/claude-code/index.ts';

export const builtInProviders = [claudeCode()];

export function AllYourAgents(opts: InstanceOptions = {}): Instance {
	return createAllYourAgents({
		...opts,
		providers: opts.providers ?? builtInProviders,
	});
}

export { claudeCode };

export default AllYourAgents;

export { emptyActivity, reduceActivity } from './core/activity.ts';
export type { AllYourAgents as AllYourAgentsInstance } from './core/instance.ts';
export { groupTurns } from './core/turns.ts';
export {
	coalesce,
	createLocalFs,
	createLocalProcesses,
	tailJsonl,
	watchDir,
	watchFile,
} from './helpers/index.ts';
export type { Clock, DebounceOptions, Fs, Processes } from './helpers/types.ts';
export type {
	InspectContext,
	InstanceOptions,
	ListContext,
	Provider,
	SessionInput,
	Unwatch,
	WatchContext,
} from './provider.ts';
export type {
	AgentsError,
	EventMeta,
	Harness,
	Session,
	SessionActivity,
	SessionEvent,
	SessionEventStream,
	SessionFilter,
	SessionKind,
	SessionSnapshot,
	SessionStatus,
	Subagent,
	SubagentFacts,
	SubagentStatus,
	TitleSource,
	Turn,
	TurnFact,
	TurnOutcome,
} from './types.ts';
