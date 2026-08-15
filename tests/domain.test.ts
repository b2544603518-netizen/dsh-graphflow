import { describe, expect, it } from 'vitest'
import { DomainCheckpointStore, graphflowDomainSpec } from '../src/domain.ts'
import { END } from '../src/types.ts'
import type { Checkpoint } from '../src/types.ts'

class FakeTable {
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
    interruptValue: { question: 'which one?' },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('graphflowDomainSpec', () => {
  it('is a well-formed domain spec', () => {
    expect(graphflowDomainSpec.name).toBe('dsh_graphflow')
    expect(graphflowDomainSpec.version).toBe(1)
    expect(Object.keys(graphflowDomainSpec.tables)).toEqual(['checkpoints'])
  })
})

describe('DomainCheckpointStore', () => {
  it('saves (validating) and round-trips a checkpoint with rich state', async () => {
    const table = new FakeTable()
    let closed = false
    const store = new DomainCheckpointStore(table, async () => {
      closed = true
    })
    const checkpoint = validCheckpoint()
    await store.save(checkpoint)
    expect(await store.load('c1')).toEqual(checkpoint)
    expect(await store.delete('c1')).toBe(true)
    expect(await store.delete('c1')).toBe(false)
    await store.dispose()
    expect(closed).toBe(true)
  })

  it('rejects a checkpoint with a blank id', async () => {
    const store = new DomainCheckpointStore(new FakeTable(), async () => {})
    await expect(store.save(validCheckpoint({ id: '' }))).rejects.toThrow()
  })

  it('rejects a checkpoint with an unknown status', async () => {
    const store = new DomainCheckpointStore(new FakeTable(), async () => {})
    await expect(store.save(validCheckpoint({ status: 'bogus' as never }))).rejects.toThrow()
  })
})
