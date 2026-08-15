import { newCheckpointId, newRunId } from './checkpoint.ts'
import { asMessage } from './json.ts'
import { applyPartial, initialState } from './state.ts'
import {
  END,
  type AgentExecutor,
  type Checkpoint,
  type CheckpointStore,
  type Edge,
  type GraphDefinition,
  type GraphNode,
  type JsonValue,
  type NodeContext,
  type NodeId,
  type RunResult,
  type State,
} from './types.ts'

/** Thrown by `NodeContext.interrupt`; caught by the executor and converted into a resumable checkpoint. */
export class InterruptSignal extends Error {
  constructor(readonly value: JsonValue) {
    super('A graph node requested an interrupt.')
    this.name = 'InterruptSignal'
  }
}

export interface GraphExecutorDeps {
  readonly store: CheckpointStore
  readonly agentExecutor?: AgentExecutor
  readonly emit?: (name: string, payload: unknown) => void
  readonly newCheckpointId?: () => string
  readonly newRunId?: () => string
  readonly now?: () => string
}

export interface GraphRunOptions {
  readonly runId?: string
  readonly signal?: AbortSignal
  readonly resumeFrom?: Checkpoint
  readonly resumeValue?: JsonValue
}

/**
 * Executes one graph definition as a super-step loop: run the current node,
 * fold its partial update through the state reducers, route through the node's
 * single outgoing edge, and checkpoint before advancing. Resumable by passing a
 * `resumeFrom` checkpoint.
 */
export class GraphExecutor {
  constructor(
    readonly graph: GraphDefinition,
    private readonly deps: GraphExecutorDeps,
  ) {}

  async run(input: State, options: GraphRunOptions = {}): Promise<RunResult> {
    const runId = options.runId ?? this.deps.newRunId?.() ?? newRunId()
    const emit = this.deps.emit
    const resumed = options.resumeFrom !== undefined
    let state: State = resumed ? options.resumeFrom.state : initialState(this.graph.stateSchema, input)
    let current: NodeId | typeof END = resumed ? options.resumeFrom.nextNode : this.graph.entry
    let pendingResumeValue: JsonValue | undefined = options.resumeValue

    emit?.('graphflow/start', { runId, graphId: this.graph.id, resumed })

    try {
      while (current !== END) {
        this.throwIfAborted(options.signal)
        const node = this.graph.nodes[current]
        if (node === undefined) {
          throw new Error(`Node '${current}' is referenced but not defined.`)
        }
        emit?.('graphflow/node-start', { runId, nodeId: current })
        const ctx: NodeContext = {
          runId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(pendingResumeValue === undefined ? {} : { resumeValue: pendingResumeValue }),
          interrupt: (value) => {
            throw new InterruptSignal(value)
          },
        }
        pendingResumeValue = undefined
        const partial = await this.executeNode(node, state, ctx)
        state = applyPartial(state, this.graph.stateSchema, partial)
        const next = this.resolveNext(current, state)
        const checkpoint = this.checkpoint(runId, state, next, 'running')
        await this.deps.store.save(checkpoint)
        emit?.('graphflow/node-end', { runId, nodeId: current })
        emit?.('graphflow/checkpoint', { runId, checkpointId: checkpoint.id, nodeId: current })
        current = next
      }

      const checkpoint = this.checkpoint(runId, state, END, 'completed')
      await this.deps.store.save(checkpoint)
      emit?.('graphflow/end', { runId, status: 'completed' })
      return { runId, status: 'completed', state, checkpointId: checkpoint.id }
    } catch (error) {
      if (error instanceof InterruptSignal) {
        const checkpoint = this.checkpoint(runId, state, current, 'interrupted', error.value)
        await this.deps.store.save(checkpoint)
        emit?.('graphflow/interrupt', { runId, nodeId: current, value: error.value })
        emit?.('graphflow/end', { runId, status: 'interrupted' })
        return { runId, status: 'interrupted', state, checkpointId: checkpoint.id, interruptValue: error.value }
      }
      if (this.isAbort(error)) {
        emit?.('graphflow/end', { runId, status: 'cancelled' })
        return { runId, status: 'cancelled', state, checkpointId: null }
      }
      emit?.('graphflow/end', { runId, status: 'failed' })
      return {
        runId,
        status: 'failed',
        state,
        checkpointId: null,
        error: { code: 'node_error', message: asMessage(error) },
      }
    }
  }

  private async executeNode(node: GraphNode, state: State, ctx: NodeContext): Promise<State> {
    if (node.kind === 'function') {
      return node.run(state, ctx)
    }
    if (this.deps.agentExecutor === undefined) {
      throw new Error('The node is an agent node but no agent executor is available.')
    }
    const request = {
      prompt: node.prompt(state, ctx),
      ...(node.provider === undefined ? {} : { provider: node.provider }),
      ...(node.model === undefined ? {} : { model: node.model }),
    }
    const result = await this.deps.agentExecutor(request, ctx)
    return { [node.key]: result.output }
  }

  private resolveNext(from: NodeId, state: State): NodeId | typeof END {
    const edges = this.graph.edges.filter(edge => edge.from === from)
    if (edges.length === 0) {
      throw new Error(`Node '${from}' has no outgoing edge. Route it to another node or END.`)
    }
    if (edges.length > 1) {
      throw new Error(`Node '${from}' declares more than one outgoing edge.`)
    }
    const edge = edges[0] as Edge
    return 'to' in edge ? edge.to : edge.route(state)
  }

  private checkpoint(
    runId: string,
    state: State,
    nextNode: NodeId | typeof END,
    status: Checkpoint['status'],
    interruptValue?: JsonValue,
  ): Checkpoint {
    return {
      id: this.deps.newCheckpointId?.() ?? newCheckpointId(),
      runId,
      graphId: this.graph.id,
      state,
      nextNode,
      status,
      updatedAt: this.deps.now?.() ?? new Date().toISOString(),
      ...(interruptValue === undefined ? {} : { interruptValue }),
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw new AbortError()
    }
  }

  private isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }
}

class AbortError extends Error {
  constructor() {
    super('The graph run was cancelled.')
    this.name = 'AbortError'
  }
}

const REDUCERS = ['override', 'append', 'merge'] as const

/** Validate a definition before registration so a bad graph fails loudly, not mid-run. */
export function validateGraph(graph: GraphDefinition): void {
  const problems: string[] = []
  if (graph.id.trim() === '') problems.push('the graph id must not be blank')
  if (graph.nodes[graph.entry] === undefined) {
    problems.push(`the entry node '${graph.entry}' is not defined`)
  }
  const fromCount = new Map<string, number>()
  for (const edge of graph.edges) {
    if (graph.nodes[edge.from] === undefined) problems.push(`edge source '${edge.from}' is not a defined node`)
    fromCount.set(edge.from, (fromCount.get(edge.from) ?? 0) + 1)
    if ('to' in edge && edge.to !== END && graph.nodes[edge.to] === undefined) {
      problems.push(`edge target '${edge.to}' is not a defined node`)
    }
  }
  for (const [from, count] of fromCount) {
    if (count > 1) problems.push(`node '${from}' declares ${count} outgoing edges (at most one is allowed)`)
  }
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (!fromCount.has(id)) problems.push(`node '${id}' has no outgoing edge`)
    if (node.kind === 'agent' && graph.stateSchema[node.key] === undefined) {
      problems.push(`agent node '${id}' writes to undeclared channel '${node.key}'`)
    }
  }
  for (const [key, channel] of Object.entries(graph.stateSchema)) {
    if (!(REDUCERS as readonly string[]).includes(channel.reducer)) {
      problems.push(`channel '${key}' has an unknown reducer`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid graph '${graph.id}': ${problems.join('; ')}.`)
  }
}
