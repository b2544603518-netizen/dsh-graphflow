import type { Context } from '@deepseek-ai/cordis';
import type { AgentExecutor, Checkpoint, CheckpointStore, GraphDefinition, JsonValue, RunResult, State } from './types.ts';
export interface GraphEngineConfig {
    readonly checkpointStore?: CheckpointStore;
    readonly agentExecutor?: AgentExecutor;
    readonly now?: () => string;
    readonly newRunId?: () => string;
    readonly newCheckpointId?: () => string;
    /** Default step limit for every run (default 100). */
    readonly maxSteps?: number;
}
export interface GraphRunOptions {
    readonly signal?: AbortSignal;
    readonly runId?: string;
    /** The agent that owns any subagents spawned by agent nodes. */
    readonly parent?: unknown;
    /** Per-run step limit override (default 100). */
    readonly maxSteps?: number;
}
/**
 * Declarative multi-agent graph orchestrator: register a graph once, run it with
 * typed state, conditional routing, and `Command`-driven control flow, and
 * resume from durable checkpoints.
 */
export declare class GraphEngine {
    private readonly ctx;
    private readonly store;
    private readonly ownsStore;
    private readonly config;
    private readonly graphs;
    private disposed;
    private constructor();
    static open(ctx: Context, config?: GraphEngineConfig): Promise<GraphEngine>;
    define(graph: GraphDefinition): void;
    run(graphId: string, input: State, options?: GraphRunOptions): Promise<RunResult>;
    resume(checkpointId: string, resumeValue?: JsonValue, options?: GraphRunOptions): Promise<RunResult>;
    getCheckpoint(id: string): Promise<Checkpoint | undefined>;
    listCheckpoints(runId: string): Promise<Checkpoint[]>;
    dispose(): Promise<void>;
    private executorDeps;
    private resolveAgentExecutor;
    private throwIfDisposed;
}
