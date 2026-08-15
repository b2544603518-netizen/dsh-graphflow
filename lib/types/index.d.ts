/** Cordis Host plugin for declarative multi-agent graph orchestration. */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-graphflow";
export declare const inject: readonly string[];
export interface Config {
}
export declare const Config: any;
/** Mount one host-wide graph orchestration engine as `ctx.graphEngine`. */
export declare function apply(ctx: Context): Promise<void>;
export type * from './types.ts';
export { END } from './types.ts';
export { GraphEngine } from './service.ts';
export { Command } from './command.ts';
export { GraphExecutor, GraphAbortSignal, InterruptSignal, validateGraph } from './graph.ts';
export { validateAgentOutput } from './agentOutput.ts';
export { MemoryCheckpointStore, newCheckpointId, newRunId } from './checkpoint.ts';
export { DomainCheckpointStore, graphflowDomainSpec } from './domain.ts';
