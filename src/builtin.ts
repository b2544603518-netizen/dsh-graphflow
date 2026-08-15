import { Command } from './command.ts'
import { END } from './types.ts'
import type { GraphDefinition } from './types.ts'

/**
 * Built-in example graphs, defined at plugin startup so the panel has something
 * to show and the model-facing `graphflow_run` tool has something to run without
 * any subagent backend (both are function-only).
 */
export const builtinGraphs: readonly GraphDefinition[] = [
  {
    id: 'research-report',
    stateSchema: {
      topic: { reducer: 'override', default: 'DSH plugins' },
      notes: { reducer: 'append' },
      quality: { reducer: 'override', default: 0 },
      attempts: { reducer: 'override', default: 0 },
      done: { reducer: 'override', default: false },
    },
    entry: 'research',
    nodes: {
      research: {
        kind: 'function',
        run: (state) => ({
          notes: `round ${Number(state.attempts) + 1}: research "${state.topic}"`,
          attempts: Number(state.attempts) + 1,
        }),
      },
      review: {
        kind: 'function',
        run: (state) => {
          const quality = 0.5 + Number(state.attempts) * 0.25
          if (quality >= 0.8) return new Command({ update: { quality, done: true }, goto: END })
          return new Command({ update: { quality }, goto: 'research' })
        },
      },
    },
    edges: [{ from: 'research', to: 'review' }],
  },
  {
    id: 'guard-demo',
    stateSchema: {
      input: { reducer: 'override', default: '' },
      verdict: { reducer: 'override', default: 'ok' },
    },
    entry: 'guard',
    nodes: {
      guard: {
        kind: 'function',
        run: (state, ctx) => {
          if (state.input === '') ctx.abort({ reason: 'empty input rejected by guard' })
          return { verdict: `accepted: ${state.input}` }
        },
      },
    },
    edges: [{ from: 'guard', to: END }],
  },
]
