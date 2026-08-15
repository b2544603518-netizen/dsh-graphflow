/**
 * dsh-graphflow client: a floating "GraphFlow" panel (shell.overlay) that polls
 * the Host state route and shows defined graphs + run history, with a Run
 * button per graph. Self-contained open/close state; no external deps beyond
 * React (host-provided) and the client slots service.
 */
import React from 'react'

interface GraphRecord {
  id: string
  nodeCount: number
  entry: string
}

interface RunRecord {
  runId: string
  graphId: string
  status: string
  startedAt: string
  finalState: unknown
  checkpointId: string | null
  error?: string
  abortValue?: unknown
}

interface Snapshot {
  graphs: GraphRecord[]
  runs: RunRecord[]
}

const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 56,
  right: 16,
  width: 340,
  maxHeight: '80vh',
  overflow: 'auto',
  background: 'var(--color-bg-elevated, #1e1f24)',
  border: '1px solid var(--color-border, #2a2b32)',
  borderRadius: 10,
  padding: 14,
  zIndex: 1000,
  pointerEvents: 'auto',
  boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 13,
  color: 'var(--color-text, #e6e6ea)',
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#2ea043',
  interrupted: '#d29922',
  rejected: '#f85149',
  failed: '#f85149',
  cancelled: '#8b949e',
}

function statusDot(status: string): React.ReactNode {
  return React.createElement('span', {
    style: {
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: STATUS_COLOR[status] ?? '#8b949e',
      marginRight: 6,
    },
  })
}

function GraphFlowPanel(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [open, setOpen] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/plugins/dsh-graphflow/state', { cache: 'no-store' })
        const data = (await res.json()) as Snapshot
        if (!cancelled) {
          setSnapshot(data)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const runGraph = async (graphId: string): Promise<void> => {
    try {
      await fetch('/plugins/dsh-graphflow/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graphId }),
      })
    } catch {
      // The next poll reflects the result; a button failure is non-fatal.
    }
  }

  if (!open) {
    return React.createElement('button', {
      style: {
        position: 'fixed',
        top: 56,
        right: 16,
        zIndex: 1000,
        pointerEvents: 'auto',
        padding: '6px 10px',
        borderRadius: 8,
        background: 'var(--color-bg-elevated, #1e1f24)',
        border: '1px solid var(--color-border, #2a2b32)',
        color: 'var(--color-text, #e6e6ea)',
        cursor: 'pointer',
      },
      onClick: () => setOpen(true),
    }, 'GraphFlow')
  }

  const graphs = snapshot?.graphs ?? []
  const runs = snapshot?.runs ?? []

  return React.createElement(
    'div',
    { style: PANEL_STYLE },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
      React.createElement('strong', null, 'GraphFlow'),
      React.createElement('button', {
        style: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16 },
        onClick: () => setOpen(false),
      }, '×'),
    ),
    error !== null && React.createElement('div', { style: { color: '#f85149', marginBottom: 8 } }, error),

    React.createElement('div', { style: { marginBottom: 12 } },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, `图 (${graphs.length})`),
      graphs.length === 0
        ? React.createElement('div', { style: { color: '#8b949e' } }, '无')
        : graphs.map((g) => React.createElement(
            'div',
            { key: g.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' } },
            React.createElement('span', null, g.id, ' · ', String(g.nodeCount), ' 节点'),
            React.createElement('button', {
              style: { padding: '2px 8px', borderRadius: 6, cursor: 'pointer' },
              onClick: () => { void runGraph(g.id) },
            }, '运行'),
          )),
    ),

    React.createElement('div', null,
      React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, `运行历史 (${runs.length})`),
      runs.length === 0
        ? React.createElement('div', { style: { color: '#8b949e' } }, '无')
        : runs.map((r) => React.createElement(
            'div',
            { key: r.runId, style: { padding: '6px 0', borderTop: '1px solid var(--color-border, #2a2b32)' } },
            React.createElement('div', null,
              statusDot(r.status),
              React.createElement('span', { style: { fontWeight: 500 } }, r.graphId),
              React.createElement('span', { style: { color: '#8b949e', marginLeft: 6 } }, r.status),
            ),
            r.error !== undefined && React.createElement('div', { style: { color: '#f85149', fontSize: 12 } }, r.error),
            React.createElement('div', { style: { color: '#8b949e', fontSize: 11, wordBreak: 'break-all' } },
              JSON.stringify(r.finalState)),
          )),
    ),
  )
}

/** Minimal structural view of the client `slots` service. */
interface SlotsRuntime {
  inject(name: string, fn: () => (() => void) | undefined): (() => void) | undefined
  register(options: { name: string; id: string; order?: number }, component: () => React.ReactElement): () => void
}

/** Client plugin: register the floating panel in shell.overlay. */
export const inject: readonly string[] = []

export function apply(ctx: { get(name: string): unknown; effect(fn: () => (() => void) | undefined): void }): void {
  ctx.effect(() => {
    const slots = ctx.get('slots') as SlotsRuntime | undefined
    if (slots === undefined) return undefined
    return slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'dsh-graphflow-panel', order: 0 },
      () => React.createElement(GraphFlowPanel),
    )) ?? undefined
  })
}
