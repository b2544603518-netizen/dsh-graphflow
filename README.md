# dsh-graphflow

English · [简体中文](./README_ZH.md)

Declarative graph orchestration for [DeepSeek Harness](https://github.com/deepseek-ai). Register a multi-agent flow as a graph of **nodes** and **edges** over **typed state**, then run it with **conditional routing**, **`Command`-driven control flow**, **structured agent output**, **guard/abort**, and **resumable checkpoints**.

Inspired by [LangGraph](https://github.com/langchain-ai/langgraph)'s state-machine model, built natively on DSH's subagent seam and Cordis lifecycle. It is a developer-facing engine: other plugins (or future agent tools) consume `ctx.graphEngine`.

## Why this over `ctx.workflowEngine`

DSH's workflow seam runs a *model-written script* that fans out subagents, but it explicitly has **no checkpoint/resume** and **no reusable orchestration**. `dsh-graphflow` fills those gaps:

- **Declarative topology** — nodes and edges are data, so a graph is inspectable, testable, and reusable by id *within a process*. Graph definitions are code, not data: they are **not persisted** across host restarts — re-`define` them after a restart.
- **Typed state with reducers** — each channel folds partial updates deterministically (`override` / `append` / `merge`) instead of hand-rolled state plumbing.
- **Conditional routing** — a node's next step is decided from state at run time.
- **Durable checkpoints** — the run snapshots its state after every node, so a crash or an interrupt can resume from where it left off without re-running expensive subagent nodes.

## Install

```bash
dsh plugin --profile web add github:b2544603518-netizen/dsh-graphflow#v0.2.2
```

The repository ships its built Host bundle, so a Git install runs no build script.

## API

The Host plugin mounts a single service:

```ts
ctx.graphEngine.define(graph)
ctx.graphEngine.run(graphId, input, options)
ctx.graphEngine.resume(checkpointId, resumeValue?, options)
ctx.graphEngine.getCheckpoint(checkpointId)
ctx.graphEngine.listCheckpoints(runId)
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

- **`function`** — synchronous or async `(state, ctx) => State | Command`. Use for routers, aggregation, and pure orchestration. Returning a `Command` also lets the node choose the next node.
- **`agent`** — `prompt(state, ctx) => string` delegated to a subagent provider; the final text is written to `key` and folded by that channel's reducer. Add an optional `name` (human-readable label), `outputSchema` (a zod schema the text is parsed/validated into), and `retries` (re-run on validation failure).

### Command

A node may return a `Command` to update state and re-route in one step:

```ts
import { Command, END } from '@dsh-external/dsh-graphflow'

const graph = {
  // ...
  nodes: {
    review: {
      kind: 'function',
      run: (state) =>
        state.quality < 0.8
          ? new Command({ goto: 'research' })            // loop back
          : new Command({ update: { done: true }, goto: END }),
    },
  },
}
```

`update` folds through the channel reducers; `goto` overrides the node's declared edge. Either is optional — `new Command({ update })` still follows the edge, and `new Command({ goto })` re-routes without touching state.

### Structured agent output

Give an agent node an `outputSchema` so its text becomes a typed state value instead of a raw string:

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

A validation failure fails the run (`RunResult.error`), or re-runs the subagent up to `retries` times with the validation error fed back.

### Abort / guard

`ctx.abort(value)` rejects the run with a typed reason (a "tripwire"), writing a `rejected` checkpoint:

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

The run returns `{ status: 'rejected', abortValue }`. Guards are just function nodes: an input guard before an agent node, an output guard after it.

### Checkpoints and resume

Every `run` returns `{ runId, checkpointId, status, state }`. To resume after a failure or an interrupt, pass the checkpoint id back:

```ts
const { checkpointId } = await ctx.graphEngine.run('report', { topic: 'x' })
const again = await ctx.graphEngine.resume(checkpointId) // re-runs from the last node
```

A node may pause for a human decision with `ctx.interrupt(value)`; the run returns `status: 'interrupted'`, and `resume(checkpointId, answer)` re-runs that node with `answer` available as `ctx.resumeValue`.

Every checkpoint carries a monotonic `step`; replay or debug a run's full history with `listCheckpoints(runId)`.

Checkpoints are durable when the Host mounts `storageDomain` (see `src/domain.ts`); otherwise an in-memory store is used.

## Events

Every run emits observe-only events for tracing: `graphflow/start`, `graphflow/node-start`, `graphflow/node-end`, `graphflow/checkpoint`, `graphflow/interrupt`, `graphflow/abort`, `graphflow/end`.

## Configuration

No configuration is required. `ctx.get('subagents')`, `ctx.get('agent')`, and `ctx.get('storageDomain')` are resolved opportunistically — function-only graphs work without any of them.

A run executes at most **`maxSteps`** nodes (default **100**) before failing with `error.code === 'max_steps_exceeded'`; override it per run (`run(id, input, { maxSteps })`) or engine-wide (`GraphEngine.open(ctx, { maxSteps })`).

## Deliberate non-goals (v0.2)

- Dynamic fan-out / map-reduce (`Send`) — planned for v0.3; DSH's `workflow` tool and subagent fork cover map-reduce today.
- Subgraph nesting (an agent node → DSH subagent already provides composition + isolation + continuability).
- Time-travel UI and checkpoint branching (`resume` re-runs linearly; `listCheckpoints` is read-only).
- A model-facing graph tool (DSH already ships `workflow`).
- Long-term memory stores and span/processor observability stacks (DSH's session persistence, storage domains, and approval stack already cover those).

## Known limits & edges

- **A `failed` or `cancelled` run returns `checkpointId: null`.** Only successful node boundaries are checkpointed. After a node throws, resume from the last successful checkpoint — find it with `listCheckpoints(runId)`.
- **Graph definitions are not persisted.** They live in memory; after a host restart you must re-`define` a graph before `resume` can resolve its checkpoint (a checkpoint stores only the `graphId`, not the definition).
- **A runaway route is bounded by `maxSteps`.** A loop that exceeds the limit fails with `max_steps_exceeded`; raise the limit only when a graph legitimately needs more than 100 node executions.
- **`ctx.interrupt(value)` discards the node's in-flight state writes.** The interrupt throws before the node's partial update is folded, and `resume` re-runs the whole node. Persist anything that must survive in the returned state or inside the interrupt value.
- **Without `outputSchema`, an agent's non-text array parts are dropped.** `coerceOutput` joins only string / `{ text }` parts and ignores numbers and objects. Use `outputSchema` when the result is structured.
- **`outputSchema: z.string()` can misread text that happens to be valid JSON.** Structured output tries `JSON.parse` first, so a bare `123`, `true`, or a quoted string is parsed before validation. Prefer non-JSON-shaped text for `z.string()` channels.
- **The `run → checkpoint` index is not atomic.** `DomainCheckpointStore` does a `get`-then-`put` on the `runs` table. One DSH process serializes this; multiple processes sharing the same storage domain can lose an index entry.

## Development

```bash
pnpm install
pnpm check   # typecheck + tests (100% coverage) + build
```

The build emits a Host ESM bundle and type declarations into `lib/` (committed for file: profile installs).
