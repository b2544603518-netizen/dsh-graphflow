import { describe, expect, it } from 'vitest'
import { builtinGraphs } from '../src/builtin.ts'
import { MemoryCheckpointStore } from '../src/checkpoint.ts'
import { GraphExecutor, validateGraph } from '../src/graph.ts'

describe('builtinGraphs', () => {
  it('are valid graphs', () => {
    for (const graph of builtinGraphs) {
      expect(() => validateGraph(graph)).not.toThrow()
    }
  })

  it('research-report completes via the Command loop', async () => {
    const report = builtinGraphs[0]!
    const executor = new GraphExecutor(report, { store: new MemoryCheckpointStore() })
    const result = await executor.run({})
    expect(result.status).toBe('completed')
    expect(result.state.done).toBe(true)
    expect(Array.isArray(result.state.notes)).toBe(true)
  })

  it('guard-demo rejects empty input', async () => {
    const guard = builtinGraphs[1]!
    const executor = new GraphExecutor(guard, { store: new MemoryCheckpointStore() })
    const result = await executor.run({})
    expect(result.status).toBe('rejected')
    expect(result.abortValue).toEqual({ reason: 'empty input rejected by guard' })
  })

  it('guard-demo accepts non-empty input', async () => {
    const guard = builtinGraphs[1]!
    const executor = new GraphExecutor(guard, { store: new MemoryCheckpointStore() })
    const result = await executor.run({ input: 'hello' })
    expect(result.status).toBe('completed')
  })
})
