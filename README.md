# dsh-graphflow

Declarative graph orchestration for [DeepSeek Harness](https://github.com/deepseek-ai). Register a multi-agent flow as a graph of **nodes** and **edges** over **typed state**, then run it with **conditional routing** and **resumable checkpoints**.

Inspired by [LangGraph](https://github.com/langchain-ai/langgraph)'s state-machine model, built natively on DSH's subagent seam and Cordis lifecycle. It is a developer-facing engine: other plugins (or future agent tools) consume `ctx.graphEngine`.

## Why this over `ctx.workflowEngine`

DSH's workflow seam runs a *model-written script* that fans out subagents, but it explicitly has **no checkpoint/resume** and **no reusable, saved orchestration**. `dsh-graphflow` fills those gaps:

- **Declarative topology** — nodes and edges are data, so a graph is inspectable, testable, and reusable by id.
- **Typed state with reducers** — each channel folds partial updates deterministically (`override` / `append` / `merge`) instead of hand-rolled state plumbing.
- **Conditional routing** — a node's next step is decided from state at run time.
- **Durable checkpoints** — the run snapshots its state after every node, so a crash or an interrupt can resume from where it left off without re-running expensive subagent nodes.

## Install

```bash
dsh plugin --profile web add github:<owner>/dsh-graphflow#v0.1.0
```

The repository ships its built Host bundle, so a Git install runs no build script.

## API

The Host plugin mounts a single service:

```ts
ctx.graphEngine.define(graph)
ctx.graphEngine.run(graphId, input, options)
ctx.graphEngine.resume(checkpointId, resumeValue?, options)
ctx.graphEngine.getCheckpoint(checkpointId)
```

### Graph shape

```ts
import { END } from '@dsh-external/dsh-graphflow'

const graph = {
  id: 'report',
  stateSchema: {
    topic: { reducer: 'override', default: '' },
    notes: { reducer: 'append' },          // collects an array
    profile: { reducer: 'merge' },          // shallow-merge objects
  },
  entry: 'plan',
  nodes: {
    plan: {
      kind: 'agent',
      key: 'topic',                         // agent output lands here
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
      route: (state) => (state.topic === '' ? END : 'plan'), // conditional
    },
  ],
}

ctx.graphEngine.define(graph)
const result = await ctx.graphEngine.run('report', { topic: 'DSH plugins' })
```

### Node kinds

- **`function`** — synchronous or async `(state, ctx) => State`. Use for routers, aggregation, and pure orchestration.
- **`agent`** — `prompt(state, ctx) => string` delegated to a subagent provider; the final text is written to `key` and folded by that channel's reducer.

### Checkpoints and resume

Every `run` returns `{ runId, checkpointId, status, state }`. To resume after a failure or an interrupt, pass the checkpoint id back:

```ts
const { checkpointId } = await ctx.graphEngine.run('report', { topic: 'x' })
const again = await ctx.graphEngine.resume(checkpointId) // re-runs from the last node
```

A node may pause for a human decision with `ctx.interrupt(value)`; the run returns `status: 'interrupted'`, and `resume(checkpointId, answer)` re-runs that node with `answer` available as `ctx.resumeValue`.

Checkpoints are durable when the Host mounts `storageDomain` (see `src/domain.ts`); otherwise an in-memory store is used.

## Events

Every run emits observe-only events for tracing: `graphflow/start`, `graphflow/node-start`, `graphflow/node-end`, `graphflow/checkpoint`, `graphflow/interrupt`, `graphflow/end`.

## Configuration

No configuration is required. `ctx.get('subagents')`, `ctx.get('agent')`, and `ctx.get('storageDomain')` are resolved opportunistically — function-only graphs work without any of them.

## Deliberate non-goals (v0.1)

- Dynamic fan-out / map-reduce (`Send`) and subgraph nesting.
- Time-travel UI and checkpoint branching.
- A model-facing graph tool (DSH already ships `workflow`).
- Long-term memory stores and guardrails (DSH's session persistence and approval stack already cover those).

## Development

```bash
pnpm install
pnpm check   # typecheck + tests (100% coverage) + build
```

The build emits a Host ESM bundle and type declarations into `lib/` (committed for file: profile installs).
