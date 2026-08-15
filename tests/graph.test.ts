import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MemoryCheckpointStore } from '../src/checkpoint.ts'
import { Command } from '../src/command.ts'
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

const fnNode = (run: (state: State, ctx: NodeContext) => State | Command = () => ({})) => ({
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
  options: { agentExecutor?: AgentExecutor; signal?: AbortSignal; resumeFrom?: Checkpoint; resumeValue?: JsonValue; maxSteps?: number } = {},
): Promise<Harness> {
  const store = new MemoryCheckpointStore()
  const events: Array<[string, unknown]> = []
  let seq = 0
  const executor = new GraphExecutor(definition, {
    store,
    ...(options.agentExecutor === undefined ? {} : { agentExecutor: options.agentExecutor }),
    emit: (name, payload) => {
      events.push([name, payload])
    },
    newRunId: () => 'run-1',
    newCheckpointId: () => `ckpt-${++seq}`,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  const result = await executor.run(input, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
    ...(options.resumeValue === undefined ? {} : { resumeValue: options.resumeValue }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
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

  it('records a monotonic step per checkpoint and lists them in order', async () => {
    const { store } = await run(linear, { log: [] })
    const checkpoints = await store.list('run-1')
    expect(checkpoints.map(c => c.step)).toEqual([0, 1, 2])
    expect(checkpoints.map(c => c.id)).toEqual(['ckpt-1', 'ckpt-2', 'ckpt-3'])
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

  it('passes a per-node model through to the executor', async () => {
    const modelGraph: GraphDefinition = {
      id: 'model',
      stateSchema: { out: { reducer: 'override' } },
      entry: 'a',
      nodes: { a: { kind: 'agent', key: 'out', prompt: () => 'x', model: 'deepseek-v4' } },
      edges: [{ from: 'a', to: END }],
    }
    let seenModel: string | undefined
    const agentExecutor: AgentExecutor = async request => {
      seenModel = request.model
      return { output: 'ok' }
    }
    const { result } = await run(modelGraph, {}, { agentExecutor })
    expect(result.status).toBe('completed')
    expect(seenModel).toBe('deepseek-v4')
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
          return { answer: ctx.resumeValue! }
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
      resumeFrom: checkpoint!,
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

  it('fails with max_steps_exceeded when a route loops past the step limit', async () => {
    const looping: GraphDefinition = {
      id: 'loop',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode(() => new Command({ goto: 'a' })) },
      edges: [],
    }
    const { result } = await run(looping, {}, { maxSteps: 5 })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('max_steps_exceeded')
    expect(result.error?.message).toMatch(/step limit/)
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
      step: 0,
      updatedAt: 't',
    }
    const { result } = await run(linear, {}, { resumeFrom: ghost })
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/referenced but not defined/)
  })
})

describe('GraphExecutor Command', () => {
  it('applies Command.update and routes via goto, skipping the edge', async () => {
    const cmd: GraphDefinition = {
      id: 'cmd',
      stateSchema: { log: { reducer: 'append' }, flag: { reducer: 'override' } },
      entry: 'a',
      nodes: {
        a: fnNode(() => new Command({ update: { flag: true }, goto: 'c' })),
        b: fnNode(() => ({ log: 'b' })),
        c: fnNode(() => ({ log: 'c' })),
      },
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: END }],
    }
    const { result } = await run(cmd)
    expect(result.status).toBe('completed')
    expect(result.state).toEqual({ log: ['c'], flag: true })
  })

  it('routes a node with no edges via Command.goto', async () => {
    const gotoOnly: GraphDefinition = {
      id: 'goto',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode(() => new Command({ goto: END })) },
      edges: [],
    }
    const { result } = await run(gotoOnly)
    expect(result.status).toBe('completed')
  })

  it('applies Command.update and still follows the edge when no goto is given', async () => {
    const updateOnly: GraphDefinition = {
      id: 'upd',
      stateSchema: { a: { reducer: 'override' }, b: { reducer: 'override' } },
      entry: 'a',
      nodes: {
        a: fnNode(() => new Command({ update: { a: 1 } })),
        b: fnNode(() => ({ b: 2 })),
      },
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: END }],
    }
    const { result } = await run(updateOnly)
    expect(result.status).toBe('completed')
    expect(result.state).toEqual({ a: 1, b: 2 })
  })
})

describe('GraphExecutor abort', () => {
  it('rejects the run with a typed reason and writes a rejected checkpoint', async () => {
    const aborted: GraphDefinition = {
      id: 'ab',
      stateSchema: {},
      entry: 'a',
      nodes: {
        a: fnNode((_state, ctx) => ctx.abort({ reason: 'invalid-input' })),
      },
      edges: [{ from: 'a', to: END }],
    }
    const { result, store, events } = await run(aborted)
    expect(result.status).toBe('rejected')
    expect(result.abortValue).toEqual({ reason: 'invalid-input' })
    const checkpoint = await store.load(result.checkpointId as string)
    expect(checkpoint?.status).toBe('rejected')
    expect(checkpoint?.abortValue).toEqual({ reason: 'invalid-input' })
    expect(events.map(([name]) => name)).toContain('graphflow/abort')
  })
})

describe('GraphExecutor node names', () => {
  it('surfaces node names in tracing events', async () => {
    const named: GraphDefinition = {
      id: 'named',
      stateSchema: {},
      entry: 'a',
      nodes: { a: { kind: 'function', name: 'worker', run: () => ({}) } },
      edges: [{ from: 'a', to: END }],
    }
    const { events } = await run(named)
    const start = events.find(([name]) => name === 'graphflow/node-start')?.[1] as { name?: string }
    expect(start?.name).toBe('worker')
  })
})

describe('GraphExecutor structured agent output', () => {
  const schemaGraph = (outputSchema: z.ZodType, retries?: number): GraphDefinition => ({
    id: 'so',
    stateSchema: { out: { reducer: 'override' } },
    entry: 'a',
    nodes: {
      a: { kind: 'agent', key: 'out', prompt: () => 'x', outputSchema, ...(retries === undefined ? {} : { retries }) },
    },
    edges: [{ from: 'a', to: END }],
  })

  it('parses a JSON payload against an object schema', async () => {
    const executor: AgentExecutor = async () => ({ output: '{"n": 3}' })
    const { result } = await run(schemaGraph(z.object({ n: z.number() })), {}, { agentExecutor: executor })
    expect(result.status).toBe('completed')
    expect(result.state.out).toEqual({ n: 3 })
  })

  it('validates bare prose against a string schema', async () => {
    const executor: AgentExecutor = async () => ({ output: 'hello' })
    const { result } = await run(schemaGraph(z.string()), {}, { agentExecutor: executor })
    expect(result.status).toBe('completed')
    expect(result.state.out).toBe('hello')
  })

  it('fails when the output does not match the schema', async () => {
    const executor: AgentExecutor = async () => ({ output: '{"n": "not-a-number"}' })
    const { result } = await run(schemaGraph(z.object({ n: z.number() })), {}, { agentExecutor: executor })
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/failed validation/)
  })

  it('retries a failed validation and succeeds on a later attempt', async () => {
    let calls = 0
    const executor: AgentExecutor = async request => {
      calls++
      if (calls === 1) return { output: '{"n": "bad"}' }
      expect(request.prompt).toMatch(/failed schema validation/)
      return { output: '{"n": 5}' }
    }
    const { result } = await run(schemaGraph(z.object({ n: z.number() }), 1), {}, { agentExecutor: executor })
    expect(result.status).toBe('completed')
    expect(result.state.out).toEqual({ n: 5 })
    expect(calls).toBe(2)
  })

  it('fails after exhausting retries', async () => {
    let calls = 0
    const executor: AgentExecutor = async () => {
      calls++
      return { output: 'always-bad' }
    }
    const { result } = await run(schemaGraph(z.object({ n: z.number() }), 1), {}, { agentExecutor: executor })
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/after 2 attempt/)
    expect(calls).toBe(2)
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

  it('accepts a node with no outgoing edge (routed via Command.goto)', () => {
    expect(() => validateGraph(graph({ nodes: { a: fnNode() }, edges: [] }))).not.toThrow()
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
