/** Cordis Host plugin for declarative multi-agent graph orchestration. */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { builtinGraphs } from './builtin.ts'
import { GraphFlowState } from './flowState.ts'
import { asMessage } from './json.ts'
import { GraphEngine } from './service.ts'
import type { JsonValue, State } from './types.ts'

export const name = 'dsh-graphflow'
export const inject: readonly string[] = []

export interface Config {}
export const Config = z.object({})

/** Minimal structural view of the `tools` service (verified against @deepseek-ai/dsh-tools). */
interface ToolsRuntime {
  register(definition: unknown): () => void
}

/** Minimal structural view of the `webServer` service (verified against @deepseek-ai/dsh-host-webserver). */
interface WebServerRuntime {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** Minimal structural view of the `systemPrompt` service. */
interface SystemPromptRuntime {
  section(section: { name: string; order: number; text: string }): () => void
}

const SECTION_ORDER = 200

const ANNOUNCEMENT = '本机已安装 dsh-graphflow 插件（DSH 声明式多智能体图编排引擎）：把多 agent 流程注册成「节点 + 边 + 类型化状态」的图，用条件路由、Command 控制流、结构化 agent 输出、guard/abort 和可断点续跑的 checkpoint 执行。模型工具 graphflow_run（按图 id 跑内置图或已定义图）与 graphflow_list（列出已定义图与运行历史）；Web GUI 侧边栏「GraphFlow」入口可视化运行与 checkpoint 轨迹。内置图：research-report（研究→评审回环）、guard-demo（空输入 guard 拦截示例）。'

/** Read a request body as UTF-8 text. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Send a lossless-JSON response with no-store headers. */
function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** Mount one host-wide graph orchestration engine as `ctx.graphEngine`. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => {
    const engine = await GraphEngine.open(ctx)
    const state = new GraphFlowState()

    // Present the engine with a recording wrapper so the panel can show what
    // was defined and run without the caller opting in.
    const graphEngine = {
      define(graph: Parameters<GraphEngine['define']>[0]): void {
        state.recordGraph(graph)
        engine.define(graph)
      },
      run: async (graphId: string, input: State, options?: Parameters<GraphEngine['run']>[2]) => {
        const result = await engine.run(graphId, input, options)
        state.recordRun(graphId, result)
        return result
      },
      resume: async (checkpointId: string, resumeValue?: JsonValue, options?: Parameters<GraphEngine['resume']>[2]) => {
        const result = await engine.resume(checkpointId, resumeValue, options)
        const checkpoint = await engine.getCheckpoint(checkpointId)
        state.recordRun(checkpoint!.graphId, result)
        return result
      },
      getCheckpoint: (id: string) => engine.getCheckpoint(id),
      listCheckpoints: (runId: string) => engine.listCheckpoints(runId),
      dispose: () => engine.dispose(),
    }

    for (const graph of builtinGraphs) {
      graphEngine.define(graph)
    }

    ctx.provide('graphEngine', graphEngine)

    const disposers: Array<() => void | Promise<void>> = []

    const systemPrompt = ctx.get('systemPrompt') as SystemPromptRuntime | undefined
    if (systemPrompt !== undefined) {
      disposers.push(systemPrompt.section({ name: 'plugin:dsh-graphflow', order: SECTION_ORDER, text: ANNOUNCEMENT }))
    }

    const webServer = ctx.get('webServer') as WebServerRuntime | undefined
    if (webServer !== undefined) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-graphflow/state',
        handler: (_req, res) => {
          sendJson(res, state.snapshot())
        },
      }))
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-graphflow/run',
        handler: async (req, res) => {
          let body: string
          try {
            body = await readBody(req)
          } catch {
            sendJson(res, { ok: false, error: 'failed to read request body' })
            return
          }
          let parsed: { graphId?: string; input?: State }
          try {
            parsed = JSON.parse(body) as { graphId?: string; input?: State }
          } catch {
            sendJson(res, { ok: false, error: 'invalid JSON body' })
            return
          }
          if (typeof parsed.graphId !== 'string' || parsed.graphId === '') {
            sendJson(res, { ok: false, error: 'graphId is required' })
            return
          }
          try {
            const result = await graphEngine.run(parsed.graphId, parsed.input ?? {})
            sendJson(res, { ok: true, result })
          } catch (error) {
            sendJson(res, { ok: false, error: asMessage(error) })
          }
        },
      }))
    }

    const tools = ctx.get('tools') as ToolsRuntime | undefined
    if (tools !== undefined) {
      disposers.push(tools.register({
        name: 'graphflow_list',
        description: '列出 dsh-graphflow 已定义的图与运行历史（图 id、节点数、入口；最近 runs 的状态、最终 state、checkpoint）。',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: { type: 'json' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async () => state.snapshot(),
      }))
      disposers.push(tools.register({
        name: 'graphflow_run',
        description: '运行 dsh-graphflow 的某个图（内置 research-report / guard-demo，或已 define 的图）并返回结果。',
        parameters: {
          type: 'object',
          properties: {
            graphId: { type: 'string', description: '要运行的图 id' },
            input: { type: 'json', description: '可选初始 state（对象）' },
          },
          required: ['graphId'],
        },
        output: {
          schema: { type: 'json' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async (args: unknown) => {
          const { graphId, input } = args as { graphId: string; input?: State }
          const result = await graphEngine.run(graphId, input ?? {})
          return { graphId, ...result }
        },
      }))
    }

    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          // Teardown must not break plugin disposal.
        }
      }
      await engine.dispose()
    }
  }, 'dsh-graphflow: graph engine')
}

export type * from './types.ts'
export { END } from './types.ts'
export { GraphEngine } from './service.ts'
export { Command } from './command.ts'
export { GraphExecutor, GraphAbortSignal, InterruptSignal, MaxStepsExceededError, validateGraph } from './graph.ts'
export { validateAgentOutput } from './agentOutput.ts'
export { GraphFlowState } from './flowState.ts'
export { builtinGraphs } from './builtin.ts'
export { MemoryCheckpointStore, newCheckpointId, newRunId } from './checkpoint.ts'
export { DomainCheckpointStore, graphflowDomainSpec } from './domain.ts'
