import { describe, expect, it } from 'vitest'
import { asMessage, cloneJson, isJsonObject } from '../src/json.ts'

describe('asMessage', () => {
  it('returns the message for errors and stringifies other values', () => {
    expect(asMessage(new Error('boom'))).toBe('boom')
    expect(asMessage('plain')).toBe('plain')
    expect(asMessage(42)).toBe('42')
  })
})

describe('isJsonObject', () => {
  it('distinguishes plain objects from arrays and primitives', () => {
    expect(isJsonObject({})).toBe(true)
    expect(isJsonObject([])).toBe(false)
    expect(isJsonObject('x')).toBe(false)
    expect(isJsonObject(null)).toBe(false)
  })
})

describe('cloneJson', () => {
  it('deep-copies so the caller cannot mutate shared state', () => {
    const original = { nested: { a: 1 } }
    const copy = cloneJson(original)
    original.nested.a = 2
    expect(copy).toEqual({ nested: { a: 1 } })
  })
})
