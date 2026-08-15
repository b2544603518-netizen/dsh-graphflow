import type { Checkpoint, CheckpointStore } from './types.ts';
export declare function newRunId(): string;
export declare function newCheckpointId(): string;
/** In-memory checkpoint store, used for tests and when no durable store is mounted. */
export declare class MemoryCheckpointStore implements CheckpointStore {
    private readonly records;
    save(checkpoint: Checkpoint): Promise<void>;
    load(id: string): Promise<Checkpoint | undefined>;
    list(runId: string): Promise<Checkpoint[]>;
    delete(id: string): Promise<boolean>;
}
