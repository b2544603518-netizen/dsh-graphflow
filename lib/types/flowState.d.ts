import type { GraphDefinition, RunResult } from './types.ts';
/** One defined graph, as the panel shows it. */
export interface GraphRecord {
    readonly id: string;
    readonly nodeCount: number;
    readonly entry: string;
}
/** One recorded run, as the panel shows it. */
export interface RunRecord {
    readonly runId: string;
    readonly graphId: string;
    readonly status: RunResult['status'];
    readonly startedAt: string;
    readonly finalState: unknown;
    readonly checkpointId: string | null;
    readonly error?: string;
    readonly abortValue?: unknown;
}
export interface GraphFlowSnapshot {
    readonly graphs: readonly GraphRecord[];
    readonly runs: readonly RunRecord[];
}
/**
 * In-memory product state: the panel's view over what has been defined and run.
 * Graphs and runs live for the host process lifetime (the durable truth is the
 * engine's checkpoint store; this is the read-only presentation surface).
 */
export declare class GraphFlowState {
    private readonly graphs;
    private readonly runs;
    private readonly maxRuns;
    constructor(maxRuns?: number);
    recordGraph(graph: GraphDefinition): void;
    recordRun(graphId: string, result: RunResult): void;
    snapshot(): GraphFlowSnapshot;
}
