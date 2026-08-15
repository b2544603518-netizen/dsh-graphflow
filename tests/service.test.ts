import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryCheckpointStore } from '../src/checkpoint.ts'
import { GraphEngine } from '../src/service.ts'
import { END, type Checkpoint, type CheckpointStore, type GraphDefinition, type NodeContext, type State } from '../src/types.ts'

const fnNode = (run: (state: State, ctx: NodeContext) => State = () => ({})) => ({ kind: 'function' as const, run })

const linear: GraphDefinition = {
  id: 'linear',
  stateSchema: { log: { reducer: 'append' } },
  entry: 'a',
  nodes: { a: fnNode(() => ({ log: 'a' })), b: fnNode(() => ({ log: 'b' })) },
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: END }],
}

const agentGraph: GraphDefinition = {
  id: 'ag',
  stateSchema: { out: { reducer: 'override' } },
  entry: 'a',
  nodes: { a: { kind: 'agent', key: 'out', prompt: () => 'do it' } },
  edges: [{ from: 'a', to: END }],
}

const interruptGraph: GraphDefinition = {
  id: 'int',
  stateSchema: { answer: { reducer: 'override' } },
  entry: 'ask',
  nodes: {
    ask: fnNode((_state, ctx: any) => {
      if (ctx.resumeValue === undefined) ctx.interrupt('need-answer')
      return { answer: ctx.resumeValue }
    }),
    done: fnNode(state => state),
  },
  edges: [{ from: 'ask', to: 'done' }, { from: 'done', to: END }],
}

interface FakeStorageDomain {
  open: () => Promise<{ table: (name: string) => unknown; close: () => Promise<void> }>
  records: Map<string, unknown>
  runRecords: Map<string, unknown>
  isClosed: () => boolean
}

function fakeStorageDomain(options: { closeThrows?: boolean } = {}): FakeStorageDomain {
  const records = new Map<string, unknown>()
  const runRecords = new Map<string, unknown>()
  let closed = false
  const table = {
    get: (key: string) => records.get(key),
    put: async (key: string, value: unknown) => {
      records.set(key, value)
    },
    delete: async (key: string) => records.delete(key),
  }
  const runTable = {
    get: (key: string) => runRecords.get(key),
    put: async (key: string, value: unknown) => {
      runRecords.set(key, value)
    },
    delete: async (key: string) => runRecords.delete(key),
  }
  return {
    open: async () => ({
      table: (name: string) => (name === 'runs' ? runTable : table),
      close: async () => {
        closed = true
        if (options.closeThrows) throw new Error('close failed')
      },
    }),
    records,
    runRecords,
    isClosed: () => closed,
  }
}

interface FakeSubagents {
  list: () => string[]
  start: (name: string, request: unknown) => Promise<{
    result: Promise<{ output: unknown; stopReason: string }>
    dispose: () => Promise<void>
  }>
  calls: Array<{ name: string; request: any }>
}

function fakeSubagents(options: { providers?: string[]; output?: unknown; stopReason?: string } = {}): FakeSubagents {
  const calls: Array<{ name: string; request: any }> = []
  const hasOutput = Object.prototype.hasOwnProperty.call(options, 'output')
  return {
    list: () => options.providers ?? ['p1'],
    start: async (name: string, request: unknown) => {
      calls.push({ name, request })
      return {
        result: Promise.resolve({
          output: hasOutput ? options.output : 'ok',
          stopReason: options.stopReason ?? 'completed',
        }),
        dispose: async () => {},
      }
    },
    calls,
  }
}

function fakeCtx(services: Record<string, unknown> = {}): Context & { emitted: Array<[string, unknown]> } {
  const emitted: Array<[string, unknown]> = []
  return {
    get: (name: string) => services[name],
    emit: (name: string, payload: unknown) => {
      emitted.push([name, payload])
    },
    emitted,
  } as unknown as Context & { emitted: Array<[string, unknown]> }
}

describe('GraphEngine.open', () => {
  it('uses a durable domain store when storageDomain is mounted', async () => {
    const domain = fakeStorageDomain()
    const engine = await GraphEngine.open(fakeCtx({ storageDomain: domain }))
    engine.define(linear)
    expect((await engine.run('linear', { log: [] })).status).toBe('completed')
    expect(domain.records.size).toBeGreaterThan(0)
    await engine.dispose()
    expect(domain.isClosed()).toBe(true)
  })

  it('falls back to an in-memory store when nothing is mounted', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(linear)
    expect((await engine.run('linear', { log: [] })).status).toBe('completed')
    await expect(engine.dispose()).resolves.toBeUndefined()
  })

  it('does not dispose a caller-provided store', async () => {
    const store = new MemoryCheckpointStore()
    let disposed = false
    ;(store as unknown as CheckpointStore & { dispose: () => Promise<void> }).dispose = async () => {
      disposed = true
    }
    const engine = await GraphEngine.open(fakeCtx(), { checkpointStore: store })
    await engine.dispose()
    expect(disposed).toBe(false)
  })

  it('swallows a failing store close during dispose', async () => {
    const domain = fakeStorageDomain({ closeThrows: true })
    const engine = await GraphEngine.open(fakeCtx({ storageDomain: domain }))
    await expect(engine.dispose()).resolves.toBeUndefined()
  })

  it('honors injected run/checkpoint id and time factories', async () => {
    let seq = 0
    const engine = await GraphEngine.open(fakeCtx(), {
      newRunId: () => 'custom-run',
      newCheckpointId: () => `custom-ckpt-${++seq}`,
      now: () => '2026-05-05T00:00:00.000Z',
    })
    engine.define(linear)
    const result = await engine.run('linear', { log: [] })
    expect(result.runId).toBe('custom-run')
    expect(result.checkpointId).toBe('custom-ckpt-3')
    const checkpoint = await engine.getCheckpoint('custom-ckpt-3')
    expect(checkpoint?.updatedAt).toBe('2026-05-05T00:00:00.000Z')
    await engine.dispose()
  })

  it('dispose is idempotent', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await engine.dispose()
    await expect(engine.dispose()).resolves.toBeUndefined()
  })
})

describe('GraphEngine.define', () => {
  it('registers a valid graph and rejects duplicates and invalid graphs', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    expect(() => engine.define(linear)).not.toThrow()
    expect(() => engine.define(linear)).toThrow(/already defined/)
    expect(() => engine.define({ ...linear, id: 'bad', entry: 'missing' })).toThrow(/not defined/)
  })

  it('rejects definitions after dispose', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await engine.dispose()
    expect(() => engine.define(linear)).toThrow(/disposed/)
  })
})

describe('GraphEngine.run', () => {
  it('runs a registered graph and emits lifecycle events', async () => {
    const ctx = fakeCtx()
    const engine = await GraphEngine.open(ctx)
    engine.define(linear)
    const result = await engine.run('linear', { log: [] })
    expect(result.status).toBe('completed')
    expect(result.state).toEqual({ log: ['a', 'b'] })
    expect(ctx.emitted.map(([name]) => name)).toContain('graphflow/start')
  })

  it('rejects an unknown graph and a disposed engine', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await expect(engine.run('nope', {})).rejects.toThrow(/Unknown graph/)
    await engine.dispose()
    await expect(engine.run('linear', {})).rejects.toThrow(/disposed/)
  })

  it('passes an explicit runId through to the run', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(linear)
    const result = await engine.run('linear', { log: [] }, { runId: 'explicit-run' })
    expect(result.runId).toBe('explicit-run')
    await engine.dispose()
  })

  it('uses a config-provided agent executor', async () => {
    const engine = await GraphEngine.open(fakeCtx(), {
      agentExecutor: async request => ({ output: `injected:${request.prompt}` }),
    })
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.state.out).toBe('injected:do it')
    await engine.dispose()
  })

  it('fails a looping graph at the config-level step limit', async () => {
    const engine = await GraphEngine.open(fakeCtx(), { maxSteps: 3 })
    engine.define({
      id: 'loop',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode() },
      edges: [{ from: 'a', route: () => 'a' }],
    })
    const result = await engine.run('loop', {})
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('max_steps_exceeded')
    await engine.dispose()
  })

  it('honors a per-run step limit override', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define({
      id: 'loop2',
      stateSchema: {},
      entry: 'a',
      nodes: { a: fnNode() },
      edges: [{ from: 'a', route: () => 'a' }],
    })
    const result = await engine.run('loop2', {}, { maxSteps: 3 })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('max_steps_exceeded')
    await engine.dispose()
  })
})

describe('GraphEngine.resume', () => {
  it('resumes an interrupted run with a resume value', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(interruptGraph)
    const first = await engine.run('int', {})
    expect(first.status).toBe('interrupted')
    const resumed = await engine.resume(first.checkpointId as string, 'answer')
    expect(resumed.status).toBe('completed')
    expect(resumed.state).toEqual({ answer: 'answer' })
  })

  it('passes a signal through resume', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(interruptGraph)
    const first = await engine.run('int', {})
    const controller = new AbortController()
    const resumed = await engine.resume(first.checkpointId as string, 'answer', { signal: controller.signal })
    expect(resumed.status).toBe('completed')
    await engine.dispose()
  })

  it('resumes without a resume value', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(linear)
    const result = await engine.run('linear', { log: [] })
    const resumed = await engine.resume(result.checkpointId as string)
    expect(resumed.status).toBe('completed')
    await engine.dispose()
  })

  it('honors a per-run step limit on resume', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define({
      id: 'resume-loop',
      stateSchema: { started: { reducer: 'override' } },
      entry: 'a',
      nodes: {
        a: fnNode((state, ctx) => {
          if (state.started === true) return {}
          if (ctx.resumeValue === undefined) ctx.interrupt('x')
          return { started: true }
        }),
      },
      edges: [{ from: 'a', route: () => 'a' }],
    })
    const first = await engine.run('resume-loop', {})
    expect(first.status).toBe('interrupted')
    const resumed = await engine.resume(first.checkpointId as string, 'go', { maxSteps: 3 })
    expect(resumed.status).toBe('failed')
    expect(resumed.error?.code).toBe('max_steps_exceeded')
    await engine.dispose()
  })

  it('rejects an unknown checkpoint', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await expect(engine.resume('nope')).rejects.toThrow(/Unknown checkpoint/)
  })

  it('rejects a checkpoint whose graph is not defined', async () => {
    const store = new MemoryCheckpointStore()
    const checkpoint: Checkpoint = {
      id: 'c',
      runId: 'r',
      graphId: 'missing',
      state: {},
      nextNode: 'a',
      status: 'running',
      step: 0,
      updatedAt: 't',
    }
    await store.save(checkpoint)
    const engine = await GraphEngine.open(fakeCtx(), { checkpointStore: store })
    await expect(engine.resume('c')).rejects.toThrow(/which is not defined/)
  })

  it('rejects resume after dispose', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await engine.dispose()
    await expect(engine.resume('c')).rejects.toThrow(/disposed/)
  })
})

describe('GraphEngine.getCheckpoint', () => {
  it('returns a stored checkpoint and undefined for a missing one', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(linear)
    const result = await engine.run('linear', { log: [] })
    expect(await engine.getCheckpoint(result.checkpointId as string)).toBeDefined()
    expect(await engine.getCheckpoint('missing')).toBeUndefined()
  })

  it('rejects lookups after dispose', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await engine.dispose()
    await expect(engine.getCheckpoint('c')).rejects.toThrow(/disposed/)
  })
})

describe('GraphEngine.listCheckpoints', () => {
  it('lists the checkpoints of a run', async () => {
    const domain = fakeStorageDomain()
    const engine = await GraphEngine.open(fakeCtx({ storageDomain: domain }))
    engine.define(linear)
    const result = await engine.run('linear', { log: [] })
    const list = await engine.listCheckpoints(result.runId)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every(c => c.runId === result.runId)).toBe(true)
    await engine.dispose()
  })

  it('rejects lookups after dispose', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    await engine.dispose()
    await expect(engine.listCheckpoints('r')).rejects.toThrow(/disposed/)
  })
})

describe('GraphEngine agent nodes', () => {
  it('uses the injected executor when provided', async () => {
    const engine = await GraphEngine.open(fakeCtx(), {
      agentExecutor: async request => ({ output: `injected:${request.prompt}` }),
    })
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('completed')
    expect(result.state.out).toBe('injected:do it')
  })

  it('fails an agent node when no executor and no subagents are available', async () => {
    const engine = await GraphEngine.open(fakeCtx())
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/no agent executor/)
  })

  it('fails an agent node when subagents exist but no parent is resolvable', async () => {
    const engine = await GraphEngine.open(fakeCtx({ subagents: fakeSubagents() }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/no agent executor/)
  })

  it('runs agent nodes through ctx.subagents with the current agent as parent', async () => {
    const subagents = fakeSubagents()
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'parent' } }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('completed')
    expect(result.state.out).toBe('ok')
    expect(subagents.calls).toHaveLength(1)
    expect(subagents.calls[0]?.name).toBe('p1')
    expect(subagents.calls[0]?.request.parent).toEqual({ id: 'parent' })
    expect(subagents.calls[0]?.request.prompt).toEqual([{ type: 'text', text: 'do it' }])
  })

  it('honors a per-node provider override', async () => {
    const subagents = fakeSubagents({ providers: ['default-provider'] })
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define({
      id: 'ag2',
      stateSchema: { out: { reducer: 'override' } },
      entry: 'a',
      nodes: { a: { kind: 'agent', key: 'out', prompt: () => 'x', provider: 'chosen' } },
      edges: [{ from: 'a', to: END }],
    })
    await engine.run('ag2', {})
    expect(subagents.calls[0]?.name).toBe('chosen')
  })

  it('uses the agent node name as the subagent label when present', async () => {
    const subagents = fakeSubagents()
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define({
      id: 'ag3',
      stateSchema: { out: { reducer: 'override' } },
      entry: 'a',
      nodes: { a: { kind: 'agent', name: 'researcher', key: 'out', prompt: () => 'x' } },
      edges: [{ from: 'a', to: END }],
    })
    await engine.run('ag3', {})
    expect(subagents.calls[0]?.request.label).toBe('researcher')
  })

  it('passes a per-node model and the run signal through to the subagent', async () => {
    const subagents = fakeSubagents()
    const controller = new AbortController()
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define({
      id: 'ag4',
      stateSchema: { out: { reducer: 'override' } },
      entry: 'a',
      nodes: { a: { kind: 'agent', key: 'out', prompt: () => 'x', model: 'deepseek-v4' } },
      edges: [{ from: 'a', to: END }],
    })
    await engine.run('ag4', {}, { signal: controller.signal })
    expect(subagents.calls[0]?.request.agentOptions).toEqual({ model: 'deepseek-v4' })
    expect(subagents.calls[0]?.request.signal).toBe(controller.signal)
  })

  it('fails an agent node when no provider is registered', async () => {
    const subagents = fakeSubagents({ providers: [] })
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/No subagent provider/)
  })

  it('fails an agent node whose subagent did not complete', async () => {
    const subagents = fakeSubagents({ stopReason: 'failed' })
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/stopped with reason 'failed'/)
  })

  it('coerces array output by joining text blocks', async () => {
    const subagents = fakeSubagents({ output: ['str', { text: 'block' }, 42, { x: 1 }, null] })
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.state.out).toBe('strblock')
  })

  it('coerces null and object output', async () => {
    const nullEngine = await GraphEngine.open(fakeCtx({ subagents: fakeSubagents({ output: null }), agent: { id: 'p' } }))
    nullEngine.define(agentGraph)
    expect((await nullEngine.run('ag', {})).state.out).toBe('')

    const objEngine = await GraphEngine.open(fakeCtx({ subagents: fakeSubagents({ output: { a: 1 } }), agent: { id: 'p' } }))
    objEngine.define(agentGraph)
    expect((await objEngine.run('ag', {})).state.out).toBe('{"a":1}')
  })

  it('coerces undefined output to an empty string', async () => {
    const subagents = fakeSubagents({ output: undefined })
    const engine = await GraphEngine.open(fakeCtx({ subagents, agent: { id: 'p' } }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.state.out).toBe('')
  })

  it('swallows a rejecting subagent dispose', async () => {
    const engine = await GraphEngine.open(fakeCtx({
      subagents: {
        list: () => ['p1'],
        start: async () => ({
          result: Promise.resolve({ output: 'ok', stopReason: 'completed' }),
          dispose: async () => {
            throw new Error('dispose failed')
          },
        }),
      },
      agent: { id: 'p' },
    }))
    engine.define(agentGraph)
    const result = await engine.run('ag', {})
    expect(result.status).toBe('completed')
    expect(result.state.out).toBe('ok')
    await engine.dispose()
  })
})
