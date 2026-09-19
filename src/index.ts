import type { AllYourAgents as Instance } from './core/instance.ts';
import { createAllYourAgents } from './core/instance.ts';
import type { InstanceOptions } from './provider.ts';
import { claudeCode } from './providers/claude-code/index.ts';
import { codexCli } from './providers/codex-cli/index.ts';
import { grokBuild } from './providers/grok-build/index.ts';
import { ohMyPi } from './providers/oh-my-pi/index.ts';

export const builtInProviders = [claudeCode(), grokBuild(), codexCli(), ohMyPi()];

export function AllYourAgents(opts: InstanceOptions = {}): Instance {
	return createAllYourAgents({
		...opts,
		providers: opts.providers ?? builtInProviders,
	});
}

export { claudeCode, codexCli, grokBuild, ohMyPi };

export default AllYourAgents;

export { emptyActivity, reduceActivity } from './core/activity.ts';
export type { AllYourAgents as AllYourAgentsInstance } from './core/instance.ts';
export { groupTurns } from './core/turns.ts';
export {
	coalesce,
	createLocalFs,
	createLocalProcesses,
	createLocalSqlite,
	tailJsonl,
	watchDir,
	watchFile,
} from './helpers/index.ts';
export type {
	Clock,
	DebounceOptions,
	Fs,
	Processes,
	Sqlite,
	SqliteRow,
	SqliteValue,
} from './helpers/types.ts';
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
