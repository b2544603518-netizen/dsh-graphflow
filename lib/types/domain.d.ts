import { z } from 'zod';
import type { Checkpoint, CheckpointStore } from './types.ts';
/**
 * The durable checkpoint domain. `defineDomain`-style identity helpers live in
 * the Host; keeping a plain spec here lets the pure schema be tested without a
 * private DSH package. The Host validates the same schemas when it opens it.
 */
export declare const graphflowDomainSpec: {
    readonly name: "dsh_graphflow";
    readonly version: 2;
    readonly tables: {
        readonly checkpoints: {
            readonly valueSchema: z.ZodObject<{
                id: z.ZodString;
                runId: z.ZodString;
                graphId: z.ZodString;
                state: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                nextNode: z.ZodString;
                status: z.ZodEnum<{
                    completed: "completed";
                    interrupted: "interrupted";
                    rejected: "rejected";
                    running: "running";
                }>;
                step: z.ZodNumber;
                interruptValue: z.ZodOptional<z.ZodUnknown>;
                abortValue: z.ZodOptional<z.ZodUnknown>;
                updatedAt: z.ZodString;
            }, z.core.$strip>;
        };
        readonly runs: {
            readonly valueSchema: z.ZodArray<z.ZodString>;
        };
    };
};
/** The minimum KV surface the durable store needs from a storage-domain table. */
export interface CheckpointTable {
    get(key: string): Checkpoint | undefined;
    put(key: string, value: Checkpoint): Promise<void>;
    delete(key: string): Promise<boolean>;
}
/** Per-run index table: runId → ordered checkpoint ids. */
export interface RunIndexTable {
    get(key: string): string[] | undefined;
    put(key: string, value: string[]): Promise<void>;
    delete(key: string): Promise<boolean>;
}
/** Checkpoint store backed by a DSH storage-domain table; survives host restarts. */
export declare class DomainCheckpointStore implements CheckpointStore {
    private readonly table;
    private readonly runsTable;
    private readonly closeDomain;
    constructor(table: CheckpointTable, runsTable: RunIndexTable, closeDomain: () => Promise<void>);
    save(checkpoint: Checkpoint): Promise<void>;
    load(id: string): Promise<Checkpoint | undefined>;
    list(runId: string): Promise<Checkpoint[]>;
    delete(id: string): Promise<boolean>;
    dispose(): Promise<void>;
}
