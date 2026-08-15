import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { validateAgentOutput } from '../src/agentOutput.ts'

describe('validateAgentOutput', () => {
  it('parses a JSON payload against an object schema', () => {
    expect(validateAgentOutput('{"n": 3}', z.object({ n: z.number() }))).toEqual({ ok: true, value: { n: 3 } })
  })

  it('validates bare prose against a string schema', () => {
    expect(validateAgentOutput('hello', z.string())).toEqual({ ok: true, value: 'hello' })
  })

  it('parses a JSON string literal against a string schema', () => {
    expect(validateAgentOutput('"hello"', z.string())).toEqual({ ok: true, value: 'hello' })
  })

  it('returns the issue message for a root-level failure', () => {
    const result = validateAgentOutput('not-a-number', z.number())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })

  it('returns a path-prefixed error message for a nested field', () => {
    const result = validateAgentOutput('{"n": "x"}', z.object({ n: z.number() }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('n:')
  })

  it('rejects a validated value that is not JSON-serializable', () => {
    const nonSerializable = {
      safeParse: () => ({ success: true as const, data: () => {} }),
    } as unknown as ZodType
    expect(validateAgentOutput('x', nonSerializable)).toEqual({
      ok: false,
      error: 'validated output is not JSON-serializable',
    })
  })
})
