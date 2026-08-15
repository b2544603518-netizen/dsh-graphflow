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
})

describe('id helpers', () => {
  it('generate prefixed, unique ids', () => {
    expect(newRunId()).toMatch(/^run_/)
    expect(newCheckpointId()).toMatch(/^ckpt_/)
    expect(newCheckpointId()).not.toBe(newCheckpointId())
  })
})
