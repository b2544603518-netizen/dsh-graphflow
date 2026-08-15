import { describe, expect, it } from 'vitest'
import { MemoryCheckpointStore } from '../src/checkpoint.ts'
import { GraphExecutor, validateGraph } from '../src/graph.ts'
import {
  END,
  type AgentExecutor,
  type Checkpoint,
  type GraphDefinition,
  type JsonValue,
  type NodeContext,
  type RunResult,
  type State,
} from '../src/types.ts'

const fnNode = (run: (state: State, ctx: NodeContext) => State = () => ({})) => ({
  kind: 'function' as const,
  run,
})

function graph(overrides: Partial<GraphDefinition>): GraphDefinition {
  return { id: 'g', stateSchema: {}, entry: 'a', nodes: {}, edges: [], ...overrides }
}

interface Harness {
  result: RunResult
  events: Array<[string, unknown]>
  store: MemoryCheckpointStore
}

async function run(
  definition: GraphDefinition,
  input: State = {},
  options: { agentExecutor?: AgentExecutor; signal?: AbortSignal; resumeFrom?: Checkpoint; resumeValue?: JsonValue } = {},
): Promise<Harness> {
  const store = new MemoryCheckpointStore()
  const events: Array<[string, unknown]> = []
  let seq = 0
  const executor = new GraphExecutor(definition, {
    store,
    agentExecutor: options.agentExecutor,
    emit: (name, payload) => {
      events.push([name, payload])
    },
    newRunId: () => 'run-1',
    newCheckpointId: () => `ckpt-${++seq}`,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  const result = await executor.run(input, {
    signal: options.signal,
    resumeFrom: options.resumeFrom,
    resumeValue: options.resumeValue,
  })
  return { result, events, store }
}

const linear: GraphDefinition = {
  id: 'linear',
  stateSchema: { log: { reducer: 'append' } },
  entry: 'a',
  nodes: {
    a: fnNode(() => ({ log: 'a' })),
    b: fnNode(() => ({ log: 'b' })),
  },
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: END }],
}

describe('GraphExecutor.run', () => {
  it('runs a linear graph, folding state and checkpointing each node', async () => {
    const { result, events, store } = await run(linear, { log: [] })
    expect(result.status).toBe('completed')
    expect(result.state).toEqual({ log: ['a', 'b'] })
    expect(result.checkpointId).toBe('ckpt-3')
    expect(events.map(([name]) => name)).toEqual([
      'graphflow/start',
      'graphflow/node-start',
      'graphflow/node-end',
      'graphflow/checkpoint',
      'graphflow/node-start',
      'graphflow/node-end',
      'graphflow/checkpoint',
      'graphflow/end',
    ])
    const completed = await store.load('ckpt-3')
    expect(completed?.status).toBe('completed')
    expect(completed?.nextNode).toBe(END)
  })

  it('routes through a conditional edge based on state', async () => {
    const conditional: GraphDefinition = {
      id: 'cond',
      stateSchema: { done: { reducer: 'override' } },
      entry: 'route',
      nodes: {
        route: fnNode(state => state),
        work: fnNode(() => ({ done: true })),
      },
      edges: [
        { from: 'route', route: state => (state.done === true ? END : 'work') },
        { from: 'work', to: END },
      ],
    }
    expect((await run(conditional, { done: false })).result.status).toBe('completed')
    expect((await run(conditional, { done: false })).result.state.done).toBe(true)
    const short = await run(conditional, { done: true })
    expect(short.result.status).toBe('completed')
    expect(short.result.state.done).toBe(true)
  })

  it('delegates an agent node to the injected executor', async () => {
    const agentGraph: GraphDefinition = {
      id: 'ag',
      stateSchema: { out: { reducer: 'override' } },
      entry: 'a',
      nodes: { a: { kind: 'agent', key: 'out', prompt: state => `p:${JSON.stringify(state)}` } },
      edges: [{ from: 'a', to: END }],
    }
    const agentExecutor: AgentExecutor = async request => ({ output: `done:${request.prompt}` })
    const { result } = await run(agentGraph, {}, { agentExecutor })
    expect(result.status).toBe('completed')
    expect(result.state.out).toBe('done:p:{}')
  })

  it('fails an agent node when no executor is available', async () => {
    const agentGraph: GraphDefinition = {
      id: 'ag',
      stateSchema: { out: { reducer: 'override' } },
      entry: 'a',
      nodes: { a: { kind: 'agent', key: 'out', prompt: () => 'x' } },
      edges: [{ from: 'a', to: END }],
    }
    const { result } = await run(agentGraph)
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/no agent executor/)
  })

  it('interrupts and resumes from the interrupt with a resume value', async () => {
    const interruptGraph: GraphDefinition = {
      id: 'int',
      stateSchema: { answer: { reducer: 'override' } },
      entry: 'ask',
      nodes: {
        ask: fnNode((_state, ctx) => {
          if (ctx.resumeValue === undefined) ctx.interrupt('need-answer')
          return { answer: ctx.resumeValue }
        }),
        done: fnNode(state => state),
      },
      edges: [{ from: 'ask', to: 'done' }, { from: 'done', to: END }],
    }
    const first = await run(interruptGraph)
    expect(first.result.status).toBe('interrupted')
    expect(first.result.interruptValue).toBe('need-answer')
    expect(first.result.checkpointId).toBe('ckpt-1')

    const checkpoint = await first.store.load('ckpt-1')
    expect(checkpoint?.status).toBe('interrupted')
    expect(checkpoint?.nextNode).toBe('ask')

    const resumed = await run(interruptGraph, {}, {
      resumeFrom: checkpoint,
      resumeValue: 'the-answer',
    })
    expect(resumed.result.status).toBe('completed')
    expect(resumed.result.state).toEqual({ answer: 'the-answer' })
  })

  it('cancels immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { result } = await run(linear, { log: [] }, { signal: controller.signal })
    expect(result.status).toBe('cancelled')
    expect(result.checkpointId).toBeNull()
  })

  it('cancels when a node aborts the signal mid-run', async () => {
    const controller = new AbortController()
    const aborting: GraphDefinition = {
      id: 'ab',
      stateSchema: {},
      entry: 'a',
      nodes: {
        a: fnNode(() => {
          controller.abort()
          return {}
        }),
        b: fnNode(),
      },
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: END }],
    }
    const { result } = await run(aborting, {}, { signal: controller.signal })
    expect(result.status).toBe('cancelled')
  })

  it('fails with the node error message preserved', async () => {
    const failing: GraphDefinition = {
      id: 'f',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode(() => { throw new Error('boom') }) },
      edges: [{ from: 'a', to: END }],
    }
    const { result } = await run(failing)
    expect(result.status).toBe('failed')
    expect(result.error).toEqual({ code: 'node_error', message: 'boom' })
  })

  it('fails a node with no outgoing edge', async () => {
    const dangling: GraphDefinition = {
      id: 'd',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode() },
      edges: [],
    }
    const { result } = await run(dangling)
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/no outgoing edge/)
  })

  it('fails a node that declares more than one outgoing edge', async () => {
    const multi: GraphDefinition = {
      id: 'm',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode(), b: fnNode() },
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: END }],
    }
    const { result } = await run(multi)
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/more than one outgoing edge/)
  })

  it('fails when a resumed checkpoint points at an undefined node', async () => {
    const ghost: Checkpoint = {
      id: 'g',
      runId: 'r',
      graphId: 'linear',
      state: { log: ['a'] },
      nextNode: 'ghost',
      status: 'running',
      updatedAt: 't',
    }
    const { result } = await run(linear, {}, { resumeFrom: ghost })
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/referenced but not defined/)
  })
})

describe('validateGraph', () => {
  it('accepts a valid graph', () => {
    expect(() => validateGraph(linear)).not.toThrow()
  })

  it('rejects a blank id', () => {
    expect(() => validateGraph(graph({ id: '  ' }))).toThrow(/must not be blank/)
  })

  it('rejects an unknown entry node', () => {
    expect(() => validateGraph(graph({ entry: 'zzz' }))).toThrow(/entry node 'zzz' is not defined/)
  })

  it('rejects an edge whose source is not a node', () => {
    const g = graph({ nodes: { a: fnNode() }, edges: [{ from: 'zzz', to: 'a' }] })
    expect(() => validateGraph(g)).toThrow(/edge source 'zzz'/)
  })

  it('rejects a fixed edge whose target is not a node', () => {
    const g = graph({ nodes: { a: fnNode() }, edges: [{ from: 'a', to: 'zzz' }] })
    expect(() => validateGraph(g)).toThrow(/edge target 'zzz'/)
  })

  it('rejects multiple outgoing edges from one node', () => {
    const g = graph({
      nodes: { a: fnNode(), b: fnNode() },
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: END }],
    })
    expect(() => validateGraph(g)).toThrow(/at most one/)
  })

  it('rejects a node with no outgoing edge', () => {
    expect(() => validateGraph(graph({ nodes: { a: fnNode() }, edges: [] }))).toThrow(/no outgoing edge/)
  })

  it('rejects an agent node writing an undeclared channel', () => {
    const g = graph({
      nodes: { a: { kind: 'agent', key: 'missing', prompt: () => 'x' } },
      edges: [{ from: 'a', to: END }],
    })
    expect(() => validateGraph(g)).toThrow(/undeclared channel 'missing'/)
  })

  it('rejects an unknown reducer', () => {
    const g = graph({
      stateSchema: { k: { reducer: 'bogus' as never } },
      nodes: { a: fnNode() },
      edges: [{ from: 'a', to: END }],
    })
    expect(() => validateGraph(g)).toThrow(/unknown reducer/)
  })
})
