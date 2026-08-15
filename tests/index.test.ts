import { describe, expect, it } from 'vitest'
import { Config, apply, inject, name } from '../src/index.ts'

describe('plugin surface', () => {
  it('declares metadata and an empty config schema', () => {
    expect(name).toBe('dsh-graphflow')
    expect(inject).toEqual([])
    expect(Config).toBeDefined()
  })

  it('mounts the engine as ctx.graphEngine and disposes it on cleanup', async () => {
    const provided = new Map<string, unknown>()
    let disposer: (() => Promise<void>) | undefined
    const ctx = {
      get: () => undefined,
      emit: () => {},
      provide: (n: string, v: unknown) => {
        provided.set(n, v)
      },
      effect: async (factory: () => any) => {
        disposer = await factory()
      },
    }
    await apply(ctx as never)
    const engine = provided.get('graphEngine') as { run: (id: string, input: unknown) => Promise<unknown> }
    expect(engine).toBeDefined()
    await disposer?.()
    await expect(engine.run('x', {})).rejects.toThrow(/disposed/)
  })
})
