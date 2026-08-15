import type { ZodType } from 'zod';
import type { JsonValue } from './types.ts';
export type AgentOutputResult = {
    readonly ok: true;
    readonly value: JsonValue;
} | {
    readonly ok: false;
    readonly error: string;
};
/**
 * Turn an agent node's raw text into a typed state value.
 *
 * Resolution order: try to `JSON.parse` the text first (so a `z.object` schema
 * matches a JSON payload); when the text is not JSON, validate it as-is (so a
 * `z.string` schema matches bare prose). A validated value is then forced
 * through a JSON round-trip so it can survive a checkpoint.
 */
export declare function validateAgentOutput(raw: string, schema: ZodType): AgentOutputResult;
