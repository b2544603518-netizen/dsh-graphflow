import type { ZodType } from 'zod'
import type { JsonValue } from './types.ts'

export type AgentOutputResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: string }

/**
 * Turn an agent node's raw text into a typed state value.
 *
 * Resolution order: try to `JSON.parse` the text first (so a `z.object` schema
 * matches a JSON payload); when the text is not JSON, validate it as-is (so a
 * `z.string` schema matches bare prose). A validated value is then forced
 * through a JSON round-trip so it can survive a checkpoint.
 */
export function validateAgentOutput(raw: string, schema: ZodType): AgentOutputResult {
  const parsed = safeParseJson(raw)
  const result = schema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: zodMessage(result.error) }
  }
  try {
    const value = JSON.parse(JSON.stringify(result.data)) as JsonValue
    return { ok: true, value }
  } catch {
    return { ok: false, error: 'validated output is not JSON-serializable' }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function zodMessage(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues
    .map(issue => {
      const path = issue.path.join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}
