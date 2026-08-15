import { z } from 'zod'
import type { Checkpoint, CheckpointStore } from './types.ts'

/**
 * Structural schema for durable checkpoints. `state` is validated as a plain
 * record (its JSON-serializability is already guaranteed by the `JsonValue`
 * type and the agent-output round-trip); a recursive `JsonValue` schema is
 * deliberately avoided because it does not typecheck cleanly with zod 4.x
 * under `exactOptionalPropertyTypes`.
 */
const checkpointSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  graphId: z.string().min(1),
  state: z.record(z.string(), z.unknown()),
  nextNode: z.string().min(1),
  status: z.enum(['running', 'interrupted', 'rejected', 'completed']),
  step: z.number().int().min(0),
  interruptValue: z.unknown().optional(),
  abortValue: z.unknown().optional(),
  updatedAt: z.string().min(1),
})

/**
 * The durable checkpoint domain. `defineDomain`-style identity helpers live in
 * the Host; keeping a plain spec here lets the pure schema be tested without a
 * private DSH package. The Host validates the same schemas when it opens it.
 */
export const graphflowDomainSpec = {
  name: 'dsh_graphflow',
  version: 2,
  tables: {
    checkpoints: { valueSchema: checkpointSchema },
    runs: { valueSchema: z.array(z.string()) },
  },
} as const

/** The minimum KV surface the durable store needs from a storage-domain table. */
export interface CheckpointTable {
  get(key: string): Checkpoint | undefined
  put(key: string, value: Checkpoint): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Per-run index table: runId → ordered checkpoint ids. */
export interface RunIndexTable {
  get(key: string): string[] | undefined
  put(key: string, value: string[]): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Checkpoint store backed by a DSH storage-domain table; survives host restarts. */
export class DomainCheckpointStore implements CheckpointStore {
  constructor(
    private readonly table: CheckpointTable,
    private readonly runsTable: RunIndexTable,
    private readonly closeDomain: () => Promise<void>,
  ) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    await this.table.put(checkpoint.id, checkpointSchema.parse(checkpoint) as Checkpoint)
    const ids = this.runsTable.get(checkpoint.runId) ?? []
    if (!ids.includes(checkpoint.id)) {
      await this.runsTable.put(checkpoint.runId, [...ids, checkpoint.id])
    }
  }

  async load(id: string): Promise<Checkpoint | undefined> {
    return this.table.get(id)
  }

  async list(runId: string): Promise<Checkpoint[]> {
    const ids = this.runsTable.get(runId) ?? []
    return ids
      .map(id => this.table.get(id))
      .filter((checkpoint): checkpoint is Checkpoint => checkpoint !== undefined)
  }

  async delete(id: string): Promise<boolean> {
    const checkpoint = this.table.get(id)
    if (checkpoint === undefined) return false
    const deleted = await this.table.delete(id)
    if (deleted) {
      const remaining = (this.runsTable.get(checkpoint.runId) ?? []).filter(entry => entry !== id)
      await this.runsTable.put(checkpoint.runId, remaining)
    }
    return deleted
  }

  async dispose(): Promise<void> {
    await this.closeDomain()
  }
}
