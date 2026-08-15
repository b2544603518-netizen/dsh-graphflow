import { randomUUID } from 'node:crypto'
import type { Checkpoint, CheckpointStore } from './types.ts'

export function newRunId(): string {
  return `run_${randomUUID()}`
}

export function newCheckpointId(): string {
  return `ckpt_${randomUUID()}`
}

/** In-memory checkpoint store, used for tests and when no durable store is mounted. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly records = new Map<string, Checkpoint>()

  async save(checkpoint: Checkpoint): Promise<void> {
    this.records.set(checkpoint.id, checkpoint)
  }

  async load(id: string): Promise<Checkpoint | undefined> {
    return this.records.get(id)
  }

  async list(runId: string): Promise<Checkpoint[]> {
    return [...this.records.values()]
      .filter(checkpoint => checkpoint.runId === runId)
      .sort((a, b) => a.step - b.step)
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id)
  }
}
