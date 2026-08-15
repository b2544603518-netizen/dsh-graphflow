import type { GraphDefinition } from './types.ts';
/**
 * Built-in example graphs, defined at plugin startup so the panel has something
 * to show and the model-facing `graphflow_run` tool has something to run without
 * any subagent backend (both are function-only).
 */
export declare const builtinGraphs: readonly GraphDefinition[];
