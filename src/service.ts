import type { Context } from '@deepseek-ai/cordis'
import { MemoryCheckpointStore } from './checkpoint.ts'
import { DomainCheckpointStore, graphflowDomainSpec } from './domain.ts'
import { GraphExecutor, validateGraph } from './graph.ts'
import type {
  AgentExecutor,
  Checkpoint,
  CheckpointStore,
  GraphDefinition,
  JsonValue,
  RunResult,
  State,
} from './types.ts'

/**
 * Minimal structural views of the DSH `subagents` / `storageDomain` services,
 * verified against `@deepseek-ai/dsh-subagent` (v0.0.1-rc) and the storage-domain
 * seam. The real `SubagentStartRequest` carries `prompt: ContentBlock[]` (not a
 * string) and routes a model override through `agentOptions.model`; `SubagentResult`
 * carries `output: ContentBlock[]` and `stopReason: SubagentStopReason`.
 */
interface SubagentRun {
  readonly result: Promise<{ readonly output: unknown; readonly stopReason: string }>
  dispose(): Promise<void>
}

interface SubagentRuntime {
  list(): readonly string[]
  start(name: string, request: unknown): Promise<SubagentRun>
}

interface StorageDomain {
  open(spec: unknown): Promise<{
    table(name: string): unknown
    close(): Promise<void>
  }>
}

export interface GraphEngineConfig {
  readonly checkpointStore?: CheckpointStore
  readonly agentExecutor?: AgentExecutor
  readonly now?: () => string
  readonly newRunId?: () => string
  readonly newCheckpointId?: () => string
  /** Default step limit for every run (default 100). */
  readonly maxSteps?: number
}

export interface GraphRunOptions {
  readonly signal?: AbortSignal
  readonly runId?: string
  /** The agent that owns any subagents spawned by agent nodes. */
  readonly parent?: unknown
  /** Per-run step limit override (default 100). */
  readonly maxSteps?: number
}

/**
 * Declarative multi-agent graph orchestrator: register a graph once, run it with
 * typed state, conditional routing, and `Command`-driven control flow, and
 * resume from durable checkpoints.
 */
export class GraphEngine {
  private readonly graphs = new Map<string, GraphDefinition>()
  private disposed = false

  private constructor(
    private readonly ctx: Context,
    private readonly store: CheckpointStore,
    private readonly ownsStore: boolean,
    private readonly config: GraphEngineConfig,
  ) {}

  static async open(ctx: Context, config: GraphEngineConfig = {}): Promise<GraphEngine> {
    let store = config.checkpointStore
    let ownsStore = false
    if (store === undefined) {
      const storageDomain = ctx.get('storageDomain') as StorageDomain | undefined
      if (storageDomain !== undefined) {
        const domain = await storageDomain.open(graphflowDomainSpec)
        store = new DomainCheckpointStore(
          domain.table('checkpoints') as never,
          domain.table('runs') as never,
          () => domain.close(),
        )
        ownsStore = true
      } else {
        store = new MemoryCheckpointStore()
        ownsStore = true
      }
    }
    return new GraphEngine(ctx, store, ownsStore, config)
  }

  define(graph: GraphDefinition): void {
    this.throwIfDisposed()
    validateGraph(graph)
    if (this.graphs.has(graph.id)) {
      throw new Error(`A graph with id '${graph.id}' is already defined.`)
    }
    this.graphs.set(graph.id, graph)
  }

  async run(graphId: string, input: State, options: GraphRunOptions = {}): Promise<RunResult> {
    this.throwIfDisposed()
    const graph = this.graphs.get(graphId)
    if (graph === undefined) throw new Error(`Unknown graph '${graphId}'.`)
    const executor = new GraphExecutor(graph, this.executorDeps(options))
    return executor.run(input, {
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
  }

  async resume(
    checkpointId: string,
    resumeValue?: JsonValue,
    options: GraphRunOptions = {},
  ): Promise<RunResult> {
    this.throwIfDisposed()
    const checkpoint = await this.store.load(checkpointId)
    if (checkpoint === undefined) throw new Error(`Unknown checkpoint '${checkpointId}'.`)
    const graph = this.graphs.get(checkpoint.graphId)
    if (graph === undefined) {
      throw new Error(`Checkpoint references graph '${checkpoint.graphId}', which is not defined.`)
    }
    const executor = new GraphExecutor(graph, this.executorDeps(options))
    return executor.run({}, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      resumeFrom: checkpoint,
      ...(resumeValue === undefined ? {} : { resumeValue }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
  }

  async getCheckpoint(id: string): Promise<Checkpoint | undefined> {
    this.throwIfDisposed()
    return this.store.load(id)
  }

  async listCheckpoints(runId: string): Promise<Checkpoint[]> {
    this.throwIfDisposed()
    return this.store.list(runId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.graphs.clear()
    if (this.ownsStore) {
      try {
        await this.store.dispose?.()
      } catch {
        // A failing store close must not break plugin teardown.
      }
    }
  }

  private executorDeps(options: GraphRunOptions) {
    const agentExecutor = this.resolveAgentExecutor(options)
    return {
      store: this.store,
      ...(agentExecutor === undefined ? {} : { agentExecutor }),
      emit: (name: string, payload: unknown) => {
        this.ctx.emit(name, payload)
      },
      ...(this.config.now === undefined ? {} : { now: this.config.now }),
      ...(this.config.newRunId === undefined ? {} : { newRunId: this.config.newRunId }),
      ...(this.config.newCheckpointId === undefined ? {} : { newCheckpointId: this.config.newCheckpointId }),
      ...(this.config.maxSteps === undefined ? {} : { maxSteps: this.config.maxSteps }),
    }
  }

  private resolveAgentExecutor(options: GraphRunOptions): AgentExecutor | undefined {
    if (this.config.agentExecutor !== undefined) return this.config.agentExecutor
    const subagents = this.ctx.get('subagents') as SubagentRuntime | undefined
    if (subagents === undefined) return undefined
    const parent = options.parent ?? this.ctx.get('agent')
    if (parent === undefined) return undefined
    return async (request, nodeCtx) => {
      const provider = request.provider ?? subagents.list()[0]
      if (provider === undefined) throw new Error('No subagent provider is available.')
      const run = await subagents.start(provider, {
        parent,
        label: request.name ?? 'graphflow-agent-node',
        prompt: [{ type: 'text', text: request.prompt }],
        ...(request.model === undefined ? {} : { agentOptions: { model: request.model } }),
        ...(nodeCtx.signal === undefined ? {} : { signal: nodeCtx.signal }),
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') {
          throw new Error(`Agent node stopped with reason '${result.stopReason}'.`)
        }
        return { output: coerceOutput(result.output) }
      } finally {
        await run.dispose().catch(() => {})
      }
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new Error('The graph engine is disposed.')
  }
}

function coerceOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map(part => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  if (output === null || output === undefined) return ''
  return JSON.stringify(output)
}
