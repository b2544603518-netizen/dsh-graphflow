import { z } from 'zod'
import type { Checkpoint, CheckpointStore, JsonValue } from './types.ts'

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
)

const checkpointSchema: z.ZodType<Checkpoint> = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  graphId: z.string().min(1),
  state: z.record(jsonValueSchema),
  nextNode: z.string().min(1),
  status: z.enum(['running', 'interrupted', 'completed']),
  interruptValue: jsonValueSchema.optional(),
  updatedAt: z.string().min(1),
})

/**
 * The durable checkpoint domain. `defineDomain`-style identity helpers live in
 * the Host; keeping a plain spec here lets the pure schema be tested without a
 * private DSH package. The Host validates the same schemas when it opens it.
 */
export const graphflowDomainSpec = {
  name: 'dsh_graphflow',
  version: 1,
  tables: {
    checkpoints: { valueSchema: checkpointSchema },
  },
} as const

/** The minimum KV surface the durable store needs from a storage-domain table. */
export interface CheckpointTable {
  get(key: string): Checkpoint | undefined
  put(key: string, value: Checkpoint): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Checkpoint store backed by a DSH storage-domain table; survives host restarts. */
export class DomainCheckpointStore implements CheckpointStore {
  constructor(
    private readonly table: CheckpointTable,
    private readonly closeDomain: () => Promise<void>,
  ) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    await this.table.put(checkpoint.id, checkpointSchema.parse(checkpoint))
  }

  async load(id: string): Promise<Checkpoint | undefined> {
    return this.table.get(id)
  }

  async delete(id: string): Promise<boolean> {
    return this.table.delete(id)
  }

  async dispose(): Promise<void> {
    await this.closeDomain()
  }
}
