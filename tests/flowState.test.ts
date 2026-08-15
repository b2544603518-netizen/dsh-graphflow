import { describe, expect, it } from 'vitest'
import { GraphFlowState } from '../src/flowState.ts'
import { END, type GraphDefinition, type RunResult } from '../src/types.ts'

const graph: GraphDefinition = {
  id: 'g',
  stateSchema: {},
  entry: 'a',
  nodes: { a: { kind: 'function', run: () => ({}) }, b: { kind: 'function', run: () => ({}) } },
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: END }],
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { runId: 'r1', status: 'completed', state: {}, checkpointId: 'c1', ...overrides }
}

describe('GraphFlowState', () => {
  it('records graphs and runs into a snapshot', () => {
    const state = new GraphFlowState()
    state.recordGraph(graph)
    state.recordRun('g', result())
    const snap = state.snapshot()
    expect(snap.graphs).toEqual([{ id: 'g', nodeCount: 2, entry: 'a' }])
    expect(snap.runs).toHaveLength(1)
    expect(snap.runs[0]?.graphId).toBe('g')
    expect(snap.runs[0]?.status).toBe('completed')
    expect(snap.runs[0]?.checkpointId).toBe('c1')
  })

  it('captures error and abortValue in the run record', () => {
    const state = new GraphFlowState()
    state.recordRun('g', result({ status: 'failed', error: { code: 'node_error', message: 'boom' } }))
    state.recordRun('g', result({ status: 'rejected', abortValue: { reason: 'x' } }))
    const runs = state.snapshot().runs
    expect(runs[0]?.abortValue).toEqual({ reason: 'x' })
    expect(runs[0]?.error).toBeUndefined()
    expect(runs[1]?.error).toBe('boom')
    expect(runs[1]?.abortValue).toBeUndefined()
  })

  it('trims old runs to the cap (newest first)', () => {
    const state = new GraphFlowState(2)
    state.recordRun('g', result({ runId: 'r1' }))
    state.recordRun('g', result({ runId: 'r2' }))
    state.recordRun('g', result({ runId: 'r3' }))
    expect(state.snapshot().runs.map(r => r.runId)).toEqual(['r3', 'r2'])
  })
})
