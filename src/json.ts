import type { JsonValue } from './types.ts'

/** Deep-copy a JSON value so reducers never share mutable structure with callers. */
export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
