/** Cordis Host plugin for declarative multi-agent graph orchestration. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GraphEngine } from './service.ts'

export const name = 'dsh-graphflow'
export const inject: readonly string[] = []

export interface Config {}
export const Config = z.object({})

/** Mount one host-wide graph orchestration engine as `ctx.graphEngine`. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => {
    const engine = await GraphEngine.open(ctx)
    ctx.provide('graphEngine', engine)
    return async () => {
      await engine.dispose()
    }
  }, 'dsh-graphflow: graph engine')
}

export type * from './types.ts'
export { END } from './types.ts'
export { GraphEngine } from './service.ts'
export { Command } from './command.ts'
export { GraphExecutor, GraphAbortSignal, InterruptSignal, validateGraph } from './graph.ts'
export { validateAgentOutput } from './agentOutput.ts'
export { MemoryCheckpointStore, newCheckpointId, newRunId } from './checkpoint.ts'
export { DomainCheckpointStore, graphflowDomainSpec } from './domain.ts'
