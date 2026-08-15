import { describe, expect, it } from 'vitest'
import { MemoryCheckpointStore } from '../src/checkpoint.ts'
import { GraphEngine } from '../src/service.ts'
import { END, type Checkpoint, type CheckpointStore, type GraphDefinition, type State } from '../src/types.ts'

const fnNode = (run: (state: State) => State = () => ({})) => ({ kind: 'function' as const, run })

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
  isClosed: () => boolean
}

function fakeStorageDomain(options: { closeThrows?: boolean } = {}): FakeStorageDomain {
  const records = new Map<string, unknown>()
  let closed = false
  const table = {
    get: (key: string) => records.get(key),
    put: async (key: string, value: unknown) => {
      records.set(key, value)
    },
    delete: async (key: string) => records.delete(key),
  }
  return {
    open: async () => ({
      table: () => table,
      close: async () => {
        closed = true
        if (options.closeThrows) throw new Error('close failed')
      },
    }),
    records,
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

function fakeCtx(services: Record<string, unknown> = {}) {
  const emitted: Array<[string, unknown]> = []
  return {
    get: (name: string) => services[name],
    emit: (name: string, payload: unknown) => {
      emitted.push([name, payload])
    },
    emitted,
  }
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
    ;(store as CheckpointStore & { dispose: () => Promise<void> }).dispose = async () => {
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
    expect(subagents.calls[0]?.request.prompt).toBe('do it')
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
})
