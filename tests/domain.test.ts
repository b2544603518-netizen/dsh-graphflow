import { describe, expect, it } from 'vitest'
import { DomainCheckpointStore, graphflowDomainSpec } from '../src/domain.ts'
import type { CheckpointTable, RunIndexTable } from '../src/domain.ts'
import { END } from '../src/types.ts'
import type { Checkpoint } from '../src/types.ts'

class FakeTable implements CheckpointTable {
  readonly records = new Map<string, Checkpoint>()
  get(key: string): Checkpoint | undefined {
    return this.records.get(key)
  }
  async put(key: string, value: Checkpoint): Promise<void> {
    this.records.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

class FakeRunTable implements RunIndexTable {
  readonly records = new Map<string, string[]>()
  get(key: string): string[] | undefined {
    return this.records.get(key)
  }
  async put(key: string, value: string[]): Promise<void> {
    this.records.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

function validCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'c1',
    runId: 'r1',
    graphId: 'g1',
    state: {
      text: 'hi',
      count: 1,
      flag: true,
      nil: null,
      list: [{ nested: 'x' }],
      obj: { a: 'b' },
    },
    nextNode: END,
    status: 'interrupted',
    step: 0,
    interruptValue: { question: 'which one?' },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeStore() {
  const table = new FakeTable()
  const runs = new FakeRunTable()
  let closed = false
  const store = new DomainCheckpointStore(table, runs, async () => {
    closed = true
  })
  return { store, table, runs, isClosed: () => closed }
}

describe('graphflowDomainSpec', () => {
  it('is a well-formed domain spec', () => {
    expect(graphflowDomainSpec.name).toBe('dsh_graphflow')
    expect(graphflowDomainSpec.version).toBe(2)
    expect(Object.keys(graphflowDomainSpec.tables)).toEqual(['checkpoints', 'runs'])
  })
})

describe('DomainCheckpointStore', () => {
  it('saves (validating) and round-trips a checkpoint with rich state', async () => {
    const { store, table, runs, isClosed } = makeStore()
    const checkpoint = validCheckpoint()
    await store.save(checkpoint)
    expect(await store.load('c1')).toEqual(checkpoint)
    expect(table.records.get('c1')).toEqual(checkpoint)
    expect(runs.records.get('r1')).toEqual(['c1'])
    expect(await store.delete('c1')).toBe(true)
    expect(await store.delete('c1')).toBe(false)
    expect(runs.records.get('r1')).toEqual([])
    await store.dispose()
    expect(isClosed()).toBe(true)
  })

  it('appends each checkpoint id to its run index once', async () => {
    const { store, runs } = makeStore()
    await store.save(validCheckpoint({ id: 'c1', step: 0 }))
    await store.save(validCheckpoint({ id: 'c2', step: 1 }))
    await store.save(validCheckpoint({ id: 'c2', step: 1 }))
    expect(runs.records.get('r1')).toEqual(['c1', 'c2'])
  })

  it('lists the checkpoints of a run in saved order', async () => {
    const { store } = makeStore()
    await store.save(validCheckpoint({ id: 'c1', step: 1 }))
    await store.save(validCheckpoint({ id: 'c2', step: 0 }))
    const list = await store.list('r1')
    expect(list.map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('returns an empty list for an unknown run', async () => {
    const { store } = makeStore()
    expect(await store.list('missing')).toEqual([])
  })

  it('leaves the run index intact when the table delete reports false', async () => {
    class DeleteFailTable implements CheckpointTable {
      readonly records = new Map<string, Checkpoint>()
      get(key: string): Checkpoint | undefined {
        return this.records.get(key)
      }
      async put(key: string, value: Checkpoint): Promise<void> {
        this.records.set(key, value)
      }
      async delete(): Promise<boolean> {
        return false
      }
    }
    const table = new DeleteFailTable()
    const runs = new FakeRunTable()
    const store = new DomainCheckpointStore(table, runs, async () => {})
    await store.save(validCheckpoint())
    expect(await store.delete('c1')).toBe(false)
    expect(runs.records.get('r1')).toEqual(['c1'])
  })

  it('handles deleting a checkpoint whose run index is absent', async () => {
    const { store, table, runs } = makeStore()
    table.records.set('c1', validCheckpoint())
    expect(await store.delete('c1')).toBe(true)
    expect(runs.records.get('r1')).toEqual([])
  })

  it('rejects a checkpoint with a blank id', async () => {
    const { store } = makeStore()
    await expect(store.save(validCheckpoint({ id: '' }))).rejects.toThrow()
  })

  it('rejects a checkpoint with an unknown status', async () => {
    const { store } = makeStore()
    await expect(store.save(validCheckpoint({ status: 'bogus' as never }))).rejects.toThrow()
  })
})
