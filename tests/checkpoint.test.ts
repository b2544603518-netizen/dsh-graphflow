import { describe, expect, it } from 'vitest'
import { MemoryCheckpointStore, newCheckpointId, newRunId } from '../src/checkpoint.ts'
import type { Checkpoint } from '../src/types.ts'

const checkpoint: Checkpoint = {
  id: 'c1',
  runId: 'r1',
  graphId: 'g1',
  state: {},
  nextNode: 'a',
  status: 'running',
  step: 0,
  updatedAt: 't',
}

describe('MemoryCheckpointStore', () => {
  it('round-trips save, load, and delete', async () => {
    const store = new MemoryCheckpointStore()
    await store.save(checkpoint)
    expect(await store.load('c1')).toEqual(checkpoint)
    expect(await store.load('missing')).toBeUndefined()
    expect(await store.delete('c1')).toBe(true)
    expect(await store.delete('c1')).toBe(false)
  })

  it('lists the checkpoints of one run ordered by step', async () => {
    const store = new MemoryCheckpointStore()
    await store.save({ ...checkpoint, id: 'c1', step: 1 })
    await store.save({ ...checkpoint, id: 'c2', step: 0 })
    await store.save({ ...checkpoint, id: 'c3', runId: 'other', step: 0 })
    const list = await store.list('r1')
    expect(list.map(c => c.id)).toEqual(['c2', 'c1'])
  })
})

describe('id helpers', () => {
  it('generate prefixed, unique ids', () => {
    expect(newRunId()).toMatch(/^run_/)
    expect(newCheckpointId()).toMatch(/^ckpt_/)
    expect(newCheckpointId()).not.toBe(newCheckpointId())
  })
})
