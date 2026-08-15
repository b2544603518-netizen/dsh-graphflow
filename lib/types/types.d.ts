/** Public graph orchestration contracts for dsh-graphflow. */
import type { ZodType } from 'zod';
import type { Command } from './command.ts';
/** Plain JSON value; graph state must survive a JSON checkpoint round-trip. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    readonly [key: string]: JsonValue;
};
/** One graph state snapshot. Every channel is a JSON value. */
export type State = {
    readonly [key: string]: JsonValue;
};
export type ReducerKind = 'override' | 'append' | 'merge';
/** A named state channel and how partial updates fold into it. */
export interface StateChannel {
    readonly reducer: ReducerKind;
    readonly default?: JsonValue;
}
export type StateSchema = {
    readonly [key: string]: StateChannel;
};
export type NodeId = string;
/** Terminal sentinel: a fixed edge may target it, or a router may return it. */
export declare const END = "__graphflow_end__";
/** Per-node execution context handed to node functions. */
export interface NodeContext {
    readonly runId: string;
    readonly signal?: AbortSignal;
    /** Present only for the first node executed after a resume, i.e. the interrupt answer. */
    readonly resumeValue?: JsonValue;
    /** Pause the run and surface `value`; a later resume re-runs this node with `resumeValue`. */
    interrupt(value: JsonValue): never;
    /** Reject the run with a typed reason (guard/tripwire); writes a `rejected` checkpoint. */
    abort(value: JsonValue): never;
}
export interface AgentNodeRequest {
    readonly prompt: string;
    readonly name?: string;
    readonly provider?: string;
    readonly model?: string;
}
export interface AgentNodeResult {
    readonly output: string;
}
/** Runs one agent node. The service backs this with `ctx.subagents`; tests inject a fake. */
export interface AgentExecutor {
    (request: AgentNodeRequest, ctx: NodeContext): Promise<AgentNodeResult>;
}
export interface FunctionNode {
    readonly kind: 'function';
    /** Human-readable label surfaced in tracing events (defaults to the node id). */
    readonly name?: string;
    readonly run: (state: State, ctx: NodeContext) => State | Command | Promise<State | Command>;
}
export interface AgentNode {
    readonly kind: 'agent';
    /** Human-readable label surfaced in tracing events and the subagent label. */
    readonly name?: string;
    readonly prompt: (state: State, ctx: NodeContext) => string;
    /** State channel that receives the agent's output. */
    readonly key: string;
    readonly provider?: string;
    readonly model?: string;
    /** When set, the agent's text output is parsed/validated before being written to `key`. */
    readonly outputSchema?: ZodType;
    /** Retry count when `outputSchema` validation fails (default 0: fail fast). */
    readonly retries?: number;
}
export type GraphNode = FunctionNode | AgentNode;
export interface FixedEdge {
    readonly from: NodeId;
    readonly to: NodeId | typeof END;
}
export interface ConditionalEdge {
    readonly from: NodeId;
    readonly route: (state: State) => NodeId | typeof END;
}
export type Edge = FixedEdge | ConditionalEdge;
export interface GraphDefinition {
    readonly id: string;
    readonly stateSchema: StateSchema;
    readonly entry: NodeId;
    readonly nodes: {
        readonly [id: string]: GraphNode;
    };
    readonly edges: readonly Edge[];
}
export type RunStatus = 'completed' | 'interrupted' | 'rejected' | 'failed' | 'cancelled';
export interface Checkpoint {
    readonly id: string;
    readonly runId: string;
    readonly graphId: string;
    readonly state: State;
    /** The node that runs next on resume. `END` means the run already finished. */
    readonly nextNode: NodeId | typeof END;
    readonly status: 'running' | 'interrupted' | 'rejected' | 'completed';
    /** Monotonic position of this checkpoint within its run. */
    readonly step: number;
    readonly interruptValue?: JsonValue;
    readonly abortValue?: JsonValue;
    readonly updatedAt: string;
}
export interface RunResult {
    readonly runId: string;
    readonly status: RunStatus;
    readonly state: State;
    readonly checkpointId: string | null;
    readonly interruptValue?: JsonValue;
    readonly abortValue?: JsonValue;
    readonly error?: {
        readonly code: string;
        readonly message: string;
    };
}
/** Durable checkpoint storage. `save`/`load`/`list`/`delete` form the minimum surface. */
export interface CheckpointStore {
    save(checkpoint: Checkpoint): Promise<void>;
    load(id: string): Promise<Checkpoint | undefined>;
    /** Every checkpoint of one run, ordered by `step`. */
    list(runId: string): Promise<Checkpoint[]>;
    delete(id: string): Promise<boolean>;
    dispose?(): Promise<void>;
}
