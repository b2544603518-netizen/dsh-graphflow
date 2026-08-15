import type { JsonValue } from './types.ts';
/** Deep-copy a JSON value so reducers never share mutable structure with callers. */
export declare function cloneJson<T extends JsonValue>(value: T): T;
export declare function isJsonObject(value: JsonValue): value is {
    [key: string]: JsonValue;
};
export declare function asMessage(error: unknown): string;
