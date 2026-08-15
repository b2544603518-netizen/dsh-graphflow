import { type AgentExecutor, type Checkpoint, type CheckpointStore, type GraphDefinition, type JsonValue, type RunResult, type State } from './types.ts';
/** Thrown by `NodeContext.interrupt`; caught by the executor and converted into a resumable checkpoint. */
export declare class InterruptSignal extends Error {
    readonly value: JsonValue;
    constructor(value: JsonValue);
}
/** Thrown by `NodeContext.abort`; caught by the executor and converted into a rejected checkpoint. */
export declare class GraphAbortSignal extends Error {
    readonly value: JsonValue;
    constructor(value: JsonValue);
}
export interface GraphExecutorDeps {
    readonly store: CheckpointStore;
    readonly agentExecutor?: AgentExecutor;
    readonly emit?: (name: string, payload: unknown) => void;
    readonly newCheckpointId?: () => string;
    readonly newRunId?: () => string;
    readonly now?: () => string;
}
export interface GraphRunOptions {
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly resumeFrom?: Checkpoint;
    readonly resumeValue?: JsonValue;
}
/**
 * Executes one graph definition as a super-step loop: run the current node,
 * fold its partial update through the state reducers, route through the node's
 * outgoing edge or a returned `Command`, and checkpoint before advancing.
 * Resumable by passing a `resumeFrom` checkpoint.
 */
export declare class GraphExecutor {
    readonly graph: GraphDefinition;
    private readonly deps;
    constructor(graph: GraphDefinition, deps: GraphExecutorDeps);
    run(input: State, options?: GraphRunOptions): Promise<RunResult>;
    private executeNode;
    private resolveNext;
    private checkpoint;
    private throwIfAborted;
    private isAbort;
}
/** Validate a definition before registration so a bad graph fails loudly, not mid-run. */
export declare function validateGraph(graph: GraphDefinition): void;
