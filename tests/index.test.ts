import { describe, expect, it } from 'vitest'
import { Config, apply, inject, name } from '../src/index.ts'

interface FakeRes {
  status: number
  headers: Record<string, unknown>
  body: string
  writeHead(status: number, headers: Record<string, unknown>): void
  end(body: string): void
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(body) {
      res.body = body
    },
  }
  return res
}

function fakeReq(body?: string): unknown {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
  }
}

function throwingReq(): unknown {
  return {
    [Symbol.asyncIterator]: async function* () {
      throw new Error('read failed')
    },
  }
}

interface FakeSystemPrompt {
  sections: Array<{ name: string; order: number; text: string }>
  section(s: { name: string; order: number; text: string }): () => void
  throwOnDispose?: boolean
}

function fakeSystemPrompt(throwOnDispose = false): FakeSystemPrompt {
  const sections: Array<{ name: string; order: number; text: string }> = []
  return {
    sections,
    section(s) {
      sections.push(s)
      return () => {
        if (throwOnDispose) throw new Error('section dispose failed')
      }
    },
  }
}

interface FakeWebServer {
  routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }>
  register(r: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void
}

function fakeWebServer(): FakeWebServer {
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }> = []
  return {
    routes,
    register(r) {
      routes.push(r)
      return () => {}
    },
  }
}

interface FakeTools {
  defs: Array<{ name: string; execute: (args: unknown) => Promise<unknown>; render: (args: unknown, value: unknown) => unknown }>
  register(d: { name: string; execute: (args: unknown) => Promise<unknown>; output: { render: (args: unknown, value: unknown) => unknown } }): () => void
}

function fakeTools(): FakeTools {
  const defs: Array<{ name: string; execute: (args: unknown) => Promise<unknown>; render: (args: unknown, value: unknown) => unknown }> = []
  return {
    defs,
    register(d) {
      defs.push({ name: d.name, execute: d.execute, render: d.output.render })
      return () => {}
    },
  }
}

async function setup(services: Record<string, unknown> = {}): Promise<{
  engine: {
    define(graph: unknown): void
    run(id: string, input?: unknown): Promise<unknown>
    resume(checkpointId: string, resumeValue?: unknown): Promise<unknown>
    getCheckpoint(id: string): Promise<unknown>
    listCheckpoints(runId: string): Promise<unknown[]>
    dispose(): Promise<void>
  }
  disposer: (() => Promise<void>) | undefined
}> {
  const provided = new Map<string, unknown>()
  let disposer: (() => Promise<void>) | undefined
  const ctx = {
    get: (n: string) => services[n],
    emit: () => {},
    provide: (n: string, v: unknown) => {
      provided.set(n, v)
    },
    effect: async (factory: () => unknown) => {
      disposer = (await factory()) as (() => Promise<void>) | undefined
    },
  }
  await apply(ctx as never)
  return {
    engine: provided.get('graphEngine') as {
      define(graph: unknown): void
      run(id: string, input?: unknown): Promise<unknown>
      resume(checkpointId: string, resumeValue?: unknown): Promise<unknown>
      getCheckpoint(id: string): Promise<unknown>
      listCheckpoints(runId: string): Promise<unknown[]>
      dispose(): Promise<void>
    },
    disposer,
  }
}

describe('plugin surface', () => {
  it('declares metadata and an empty config schema', () => {
    expect(name).toBe('dsh-graphflow')
    expect(inject).toEqual([])
    expect(Config).toBeDefined()
  })
})

describe('apply', () => {
  it('mounts the engine, defines built-ins, and disposes on cleanup', async () => {
    const { engine, disposer } = await setup()
    expect(engine).toBeDefined()
    const result = (await engine.run('research-report', {})) as { status: string }
    expect(result.status).toBe('completed')
    await disposer?.()
    await expect(engine.run('research-report', {})).rejects.toThrow(/disposed/)
  })

  it('registers the system prompt section, web routes, and tools', async () => {
    const systemPrompt = fakeSystemPrompt()
    const webServer = fakeWebServer()
    const tools = fakeTools()
    await setup({ systemPrompt, webServer, tools })
    expect(systemPrompt.sections).toHaveLength(1)
    expect(systemPrompt.sections[0]?.name).toBe('plugin:dsh-graphflow')
    expect(webServer.routes.map(r => r.path)).toEqual([
      '/plugins/dsh-graphflow/state',
      '/plugins/dsh-graphflow/run',
    ])
    expect(tools.defs.map(d => d.name)).toEqual(['graphflow_list', 'graphflow_run'])
  })

  it('serves a snapshot from the /state route after a run', async () => {
    const webServer = fakeWebServer()
    const { engine } = await setup({ webServer })
    await engine.run('research-report', {})
    const res = fakeRes()
    const route = webServer.routes.find(r => r.path.endsWith('/state'))!
    ;(route.handler as (req: unknown, res: FakeRes) => void)({}, res)
    const body = JSON.parse(res.body) as { runs: Array<{ graphId: string; status: string }> }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]?.graphId).toBe('research-report')
    expect(body.runs[0]?.status).toBe('completed')
  })

  it('runs a graph through the /run route', async () => {
    const webServer = fakeWebServer()
    await setup({ webServer })
    const route = webServer.routes.find(r => r.path.endsWith('/run'))!
    const res = fakeRes()
    await (route.handler as (req: unknown, res: FakeRes) => Promise<void>)(fakeReq('{"graphId":"guard-demo","input":{"input":"hi"}}'), res)
    const body = JSON.parse(res.body) as { ok: boolean; result?: { status: string } }
    expect(body.ok).toBe(true)
    expect(body.result?.status).toBe('completed')
  })

  it('rejects the /run route on a missing graphId', async () => {
    const webServer = fakeWebServer()
    await setup({ webServer })
    const route = webServer.routes.find(r => r.path.endsWith('/run'))!
    const res = fakeRes()
    await (route.handler as (req: unknown, res: FakeRes) => Promise<void>)(fakeReq('{}'), res)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'graphId is required' })
  })

  it('rejects the /run route on invalid JSON and a failing body read', async () => {
    const webServer = fakeWebServer()
    await setup({ webServer })
    const route = webServer.routes.find(r => r.path.endsWith('/run'))!
    const res1 = fakeRes()
    await (route.handler as (req: unknown, res: FakeRes) => Promise<void>)(fakeReq('not-json'), res1)
    expect(JSON.parse(res1.body)).toEqual({ ok: false, error: 'invalid JSON body' })
    const res2 = fakeRes()
    await (route.handler as (req: unknown, res: FakeRes) => Promise<void>)(throwingReq(), res2)
    expect(JSON.parse(res2.body)).toEqual({ ok: false, error: 'failed to read request body' })
  })

  it('surfaces a run error from the /run route', async () => {
    const webServer = fakeWebServer()
    await setup({ webServer })
    const route = webServer.routes.find(r => r.path.endsWith('/run'))!
    const res = fakeRes()
    await (route.handler as (req: unknown, res: FakeRes) => Promise<void>)(fakeReq('{"graphId":"missing"}'), res)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: expect.stringMatching(/Unknown graph/) })
  })

  it('lists graphs and runs through graphflow_list', async () => {
    const tools = fakeTools()
    const { engine } = await setup({ tools })
    await engine.run('guard-demo', { input: 'x' })
    const list = tools.defs.find(d => d.name === 'graphflow_list')!
    const snapshot = (await list.execute({})) as { graphs: Array<{ id: string }>; runs: Array<{ graphId: string }> }
    expect(snapshot.graphs.map(g => g.id)).toEqual(['research-report', 'guard-demo'])
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]?.graphId).toBe('guard-demo')
  })

  it('runs a graph through graphflow_run', async () => {
    const tools = fakeTools()
    await setup({ tools })
    const run = tools.defs.find(d => d.name === 'graphflow_run')!
    const result = (await run.execute({ graphId: 'research-report' })) as { graphId: string; status: string }
    expect(result.graphId).toBe('research-report')
    expect(result.status).toBe('completed')
  })

  it('disposes even when a section disposer throws', async () => {
    const systemPrompt = fakeSystemPrompt(true)
    const { disposer } = await setup({ systemPrompt })
    await expect(disposer?.()).resolves.toBeUndefined()
  })

  it('delegates resume/getCheckpoint/listCheckpoints/dispose and renders tool output', async () => {
    const tools = fakeTools()
    const { engine } = await setup({ tools })
    engine.define({
      id: 'int',
      stateSchema: { answer: { reducer: 'override' } },
      entry: 'a',
      nodes: {
        a: {
          kind: 'function',
          run: (_s: unknown, ctx: { resumeValue?: unknown; interrupt(v: unknown): never }): { answer: unknown } => {
            if (ctx.resumeValue === undefined) ctx.interrupt('x')
            return { answer: ctx.resumeValue }
          },
        },
      },
      edges: [{ from: 'a', to: '__graphflow_end__' }],
    })
    const first = (await engine.run('int', {})) as { status: string; checkpointId: string; runId: string }
    expect(first.status).toBe('interrupted')
    const resumed = (await engine.resume(first.checkpointId, 'go')) as { status: string }
    expect(resumed.status).toBe('completed')
    await engine.getCheckpoint(first.checkpointId)
    await engine.listCheckpoints(first.runId)

    const list = tools.defs.find(d => d.name === 'graphflow_list')!
    expect(list.render({}, { a: 1 })).toEqual([{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }])
    const run = tools.defs.find(d => d.name === 'graphflow_run')!
    expect(run.render({}, { b: 2 })).toEqual([{ type: 'text', text: JSON.stringify({ b: 2 }, null, 2) }])

    await engine.dispose()
    await expect(engine.run('int', {})).rejects.toThrow(/disposed/)
  })
})
