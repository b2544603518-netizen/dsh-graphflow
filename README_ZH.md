# dsh-graphflow

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的声明式图编排引擎。把一个多 agent 流程注册成「**节点 + 边 + 类型化状态**」构成的图，然后用**条件路由**、**`Command` 控制流**、**结构化 agent 输出**、**guard/abort** 和**可断点续跑的 checkpoint** 来执行。

设计借鉴 [LangGraph](https://github.com/langchain-ai/langgraph) 的状态机模型，原生构建在 DSH 的 subagent 接缝和 Cordis 生命周期之上。它是**面向开发者**的引擎：其他插件（或未来的 agent 工具）通过 `ctx.graphEngine` 来消费它。

> English version: [README.md](./README.md)

## 它到底有什么用（效果）

一句话：把「跑起来就断不了、只能一条道走到黑」的多 agent 任务，变成「**可断点续跑、可动态改道、产出是校验过的结构化数据、不合格能叫停、全程可复盘**」的编排。

| 能力 | 没有它之前 | 有了它之后 |
|---|---|---|
| **checkpoint / resume** | 多 agent 任务跑 10 个节点，第 7 个崩了或被中断，**从头重跑**，前面烧的 token 全浪费 | 从第 7 个节点**断点续跑**，只补跑剩下的（这是它相对 DSH 自带 `workflow` 工具的核心差异） |
| **Command** | 节点想「结果太差就重试自己」只能把决策塞进 state，再靠边上的 `route(state)` 绕路去猜 | 节点 `return new Command({ goto: 'research' })` **直接决定下一步**，想跳就跳、想回环就回环 |
| **结构化输出** | agent 节点吐**裸文本**，后续路由/聚合消费不了 | 声明 `outputSchema`（zod），产出是**校验过的类型化 JSON**，能直接进条件路由和 reducer；错了还能 `retries` 回喂重试 |
| **guard / abort** | 输入不合规、输出不合格**拦不住**（DSH 审批栈只管「工具调用放不放行」，不管「内容」） | `ctx.abort(reason)` 带原因**终止整次 run**，写一个 `rejected` checkpoint，tripwire 语义 |
| **checkpoint 历史 + step** | 想复盘「这次 run 到底走了哪几步」没入口 | `listCheckpoints(runId)` 列出**每一步的状态快照**，按 `step` 排序，可重放/调试 |

一个典型效果（「研究 → 评审 → 不够好就回环重试」）：

```ts
review: {
  kind: 'function',
  run: (state) =>
    state.quality < 0.8
      ? new Command({ goto: 'research' })                    // 回环
      : new Command({ update: { done: true }, goto: END }),  // 带结论结束
}
```

## 为什么不用 `ctx.workflowEngine`

DSH 的 workflow 接缝跑的是「模型现写的脚本」去扇出子代理，但它**没有 checkpoint/resume**，也**没有可复用的编排**。`dsh-graphflow` 补齐这两块：

- **声明式拓扑** —— 节点和边都是数据，图可检查、可测试、可按 id 复用（**进程内**）。图定义是代码、不是数据：**不跨重启持久化**，重启后要重新 `define`。
- **带 reducer 的类型化状态** —— 每个 channel 用确定性方式折叠局部更新（`override` / `append` / `merge`），不用手搓状态管道。
- **条件路由** —— 节点的下一步在运行时根据 state 决定。
- **持久化 checkpoint** —— 每跑完一个节点就快照一次 state，崩溃或中断后能从原地恢复，不用重跑昂贵的 agent 节点。

## 安装

```bash
dsh plugin --profile web add github:b2544603518-netizen/dsh-graphflow#v0.3.0
```

仓库自带已构建的 Host bundle，Git 安装时无需跑构建脚本。

## API

Host 插件只挂载一个服务：

```ts
ctx.graphEngine.define(graph)
ctx.graphEngine.run(graphId, input, options)
ctx.graphEngine.resume(checkpointId, resumeValue?, options)
ctx.graphEngine.getCheckpoint(checkpointId)
ctx.graphEngine.listCheckpoints(runId)
```

### 图的形态

```ts
import { END } from '@dsh-external/dsh-graphflow'

const graph = {
  id: 'report',
  stateSchema: {
    topic: { reducer: 'override', default: '' },
    notes: { reducer: 'append' },          // 收集成数组
    profile: { reducer: 'merge' },          // 浅合并对象
  },
  entry: 'plan',
  nodes: {
    plan: {
      kind: 'agent',
      key: 'topic',                         // agent 输出落到这里
      prompt: (state) => `Plan a report about ${state.topic}`,
    },
    research: {
      kind: 'function',
      run: (state) => ({ notes: [`research: ${state.topic}`] }),
    },
    route: {
      kind: 'function',
      run: (state) => state,
    },
  },
  edges: [
    { from: 'plan', to: 'research' },
    { from: 'research', to: 'route' },
    {
      from: 'route',
      route: (state) => (state.topic === '' ? END : 'plan'), // 条件路由
    },
  ],
}

ctx.graphEngine.define(graph)
const result = await ctx.graphEngine.run('report', { topic: 'DSH plugins' })
```

### 节点类型

- **`function`** —— 同步或异步的 `(state, ctx) => State | Command`。用于路由、聚合和纯编排。返回 `Command` 时还能让节点自己选下一个节点。
- **`agent`** —— `prompt(state, ctx) => string` 委托给某个 subagent provider；最终文本写入 `key`，再由该 channel 的 reducer 折叠。可选 `name`（人读标签）、`outputSchema`（把文本解析/校验成指定 zod 类型的 schema）、`retries`（校验失败重试次数）。

### Command

节点可以返回一个 `Command`，一步完成「更新状态 + 重新路由」：

```ts
import { Command, END } from '@dsh-external/dsh-graphflow'

const graph = {
  // ...
  nodes: {
    review: {
      kind: 'function',
      run: (state) =>
        state.quality < 0.8
          ? new Command({ goto: 'research' })            // 回环
          : new Command({ update: { done: true }, goto: END }),
    },
  },
}
```

`update` 走 channel reducer 折叠；`goto` 覆盖节点声明的边。二者都可选——`new Command({ update })` 仍顺着边走，`new Command({ goto })` 只改道、不动状态。

### 结构化 agent 输出

给 agent 节点一个 `outputSchema`，让它的文本变成类型化状态值而不是裸字符串：

```ts
import { z } from 'zod'

nodes: {
  extract: {
    kind: 'agent',
    key: 'result',
    prompt: s => `Extract facts from ${s.doc}`,
    outputSchema: z.object({ facts: z.array(z.string()) }),
    retries: 1,
  },
}
```

校验失败会让整次 run 失败（`RunResult.error`），或者带着校验错误回喂子代理重跑，最多 `retries` 次。

### Abort / guard

`ctx.abort(value)` 用一个类型化原因拒绝整次 run（「tripwire」语义），并写一个 `rejected` checkpoint：

```ts
nodes: {
  check: {
    kind: 'function',
    run: (_state, ctx) => {
      if (isInvalid(_state)) ctx.abort({ reason: 'bad-input' })
      return {}
    },
  },
}
```

run 返回 `{ status: 'rejected', abortValue }`。guard 就是普通 function 节点：agent 前放一个输入 guard，agent 后放一个输出 guard。

### Checkpoint 与断点续跑

每次 `run` 返回 `{ runId, checkpointId, status, state }`。失败或中断后想续跑，把 checkpoint id 传回去：

```ts
const { checkpointId } = await ctx.graphEngine.run('report', { topic: 'x' })
const again = await ctx.graphEngine.resume(checkpointId) // 从最后一个节点重跑
```

节点可以用 `ctx.interrupt(value)` 暂停等人做决定；run 返回 `status: 'interrupted'`，`resume(checkpointId, answer)` 会让该节点拿到 `answer`（即 `ctx.resumeValue`）重新跑。

每个 checkpoint 带一个单调递增的 `step`；用 `listCheckpoints(runId)` 回放/调试整次 run 的完整历史。

当 Host 挂载了 `storageDomain` 时 checkpoint 持久化（见 `src/domain.ts`）；否则使用内存存储。

## 事件

每次 run 都会发出仅供观察的追踪事件：`graphflow/start`、`graphflow/node-start`、`graphflow/node-end`、`graphflow/checkpoint`、`graphflow/interrupt`、`graphflow/abort`、`graphflow/end`。

## 配置

无需配置。`ctx.get('subagents')`、`ctx.get('agent')`、`ctx.get('storageDomain')` 按需探测——纯 function 的图三者都不需要。

一次 run 最多执行 **`maxSteps`** 个节点（默认 **100**），超过即以 `error.code === 'max_steps_exceeded'` 失败；可按 run 覆盖（`run(id, input, { maxSteps })`）或引擎级设置（`GraphEngine.open(ctx, { maxSteps })`）。

## 明确的非目标（v0.2）

- 动态扇出 / map-reduce（`Send`）——计划 v0.3；DSH 的 `workflow` 工具和 subagent fork 今天已能覆盖 map-reduce。
- 子图嵌套（agent 节点 → DSH subagent 已提供组合 + 隔离 + 可续聊）。
- 时间旅行 UI 和 checkpoint 分叉（`resume` 是线性重跑；`listCheckpoints` 只读）。
- 面向模型的图工具（DSH 已自带 `workflow`）。
- 长期记忆存储和 span/processor 可观测栈（DSH 的会话持久化、storage domain、审批栈已覆盖）。

## 已知限制与边界

- **`failed` 或 `cancelled` 的 run 返回 `checkpointId: null`。** 只有成功完成的节点边界才写 checkpoint。节点抛错后，用 `listCheckpoints(runId)` 找到最后一个成功 checkpoint 再续跑。
- **图定义不持久化。** 它们存在内存里；宿主重启后必须先重新 `define`，`resume` 才能解析 checkpoint（checkpoint 只存了 `graphId`，不存定义本身）。
- **失控回环由 `maxSteps` 兜底。** 超过限制的回环会以 `max_steps_exceeded` 失败；只有当图确实需要超过 100 次节点执行时才调高限制。
- **`ctx.interrupt(value)` 会丢弃该节点在调用前已写的局部状态。** interrupt 在 partial update 折叠前抛出，`resume` 时整节点重跑。需要保留的状态请放进返回值或 interrupt value 里。
- **不加 `outputSchema` 时，agent 返回的非文本数组片段会被静默丢弃。** `coerceOutput` 只拼接 string / `{ text }` 片段，数字和对象被忽略。结果要是结构化的，请用 `outputSchema`。
- **`outputSchema: z.string()` 对「碰巧是合法 JSON 的文本」会误判。** 结构化输出先尝试 `JSON.parse`，所以裸的 `123`、`true` 或带引号的字符串会先被解析再校验。`z.string()` 的 channel 请避免让 agent 输出可被 JSON 解析的裸值。
- **`run → checkpoint` 索引写入非原子。** `DomainCheckpointStore` 对 `runs` 表是「先 get 再 put」。单 DSH 进程内有锁串行化；多个进程共享同一存储域时可能丢索引。

## 开发

```bash
pnpm install
pnpm check   # typecheck + tests（100% 覆盖率）+ build
```

构建会把 Host ESM bundle 和类型声明输出到 `lib/`（已提交，供 file: 形式 profile 安装）。
