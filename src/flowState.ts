import type { GraphDefinition, RunResult } from './types.ts'

/** One defined graph, as the panel shows it. */
export interface GraphRecord {
  readonly id: string
  readonly nodeCount: number
  readonly entry: string
}

/** One recorded run, as the panel shows it. */
export interface RunRecord {
  readonly runId: string
  readonly graphId: string
  readonly status: RunResult['status']
  readonly startedAt: string
  readonly finalState: unknown
  readonly checkpointId: string | null
  readonly error?: string
  readonly abortValue?: unknown
}

export interface GraphFlowSnapshot {
  readonly graphs: readonly GraphRecord[]
  readonly runs: readonly RunRecord[]
}

/**
 * In-memory product state: the panel's view over what has been defined and run.
 * Graphs and runs live for the host process lifetime (the durable truth is the
 * engine's checkpoint store; this is the read-only presentation surface).
 */
export class GraphFlowState {
  private readonly graphs = new Map<string, GraphRecord>()
  private readonly runs: RunRecord[] = []
  private readonly maxRuns: number

  constructor(maxRuns = 50) {
    this.maxRuns = maxRuns
  }

  recordGraph(graph: GraphDefinition): void {
    this.graphs.set(graph.id, {
      id: graph.id,
      nodeCount: Object.keys(graph.nodes).length,
      entry: graph.entry,
    })
  }

  recordRun(graphId: string, result: RunResult): void {
    this.runs.unshift({
      runId: result.runId,
      graphId,
      status: result.status,
      startedAt: new Date().toISOString(),
      finalState: result.state,
      checkpointId: result.checkpointId,
      ...(result.error === undefined ? {} : { error: result.error.message }),
      ...(result.abortValue === undefined ? {} : { abortValue: result.abortValue }),
    })
    if (this.runs.length > this.maxRuns) {
      this.runs.length = this.maxRuns
    }
  }

  snapshot(): GraphFlowSnapshot {
    return {
      graphs: [...this.graphs.values()],
      runs: [...this.runs],
    }
  }
}
