import { describe, expect, it } from 'vitest'
import { applyPartial, initialState } from '../src/state.ts'
import type { StateSchema } from '../src/types.ts'

const schema: StateSchema = {
  title: { reducer: 'override', default: 'untitled' },
  notes: { reducer: 'append' },
  meta: { reducer: 'merge' },
}

describe('initialState', () => {
  it('applies channel defaults then folds input through reducers', () => {
    expect(initialState(schema, { title: 'x', notes: ['a'] })).toEqual({
      title: 'x',
      notes: ['a'],
    })
  })

  it('keeps defaults when the input is empty', () => {
    expect(initialState(schema, {})).toEqual({ title: 'untitled' })
  })

  it('does not share the default object across runs', () => {
    const withDefault: StateSchema = { items: { reducer: 'append', default: ['seed'] } }
    const first = initialState(withDefault, {})
    const second = initialState(withDefault, {})
    first.items.push('mutated')
    expect(second.items).toEqual(['seed'])
  })
})

describe('applyPartial', () => {
  it('override replaces the previous value', () => {
    expect(applyPartial({ title: 'a' }, schema, { title: 'b' })).toEqual({ title: 'b' })
  })

  it('append accumulates arrays', () => {
    expect(applyPartial({ notes: ['a'] }, schema, { notes: ['b', 'c'] })).toEqual({
      notes: ['a', 'b', 'c'],
    })
  })

  it('append wraps a non-array update as a single element', () => {
    expect(applyPartial({ notes: ['a'] }, schema, { notes: 'b' })).toEqual({ notes: ['a', 'b'] })
  })

  it('append starts a new array when the channel is absent', () => {
    expect(applyPartial({}, schema, { notes: 'x' })).toEqual({ notes: ['x'] })
  })

  it('merge shallow-merges objects with the new keys winning', () => {
    expect(applyPartial({ meta: { a: 1, b: 2 } }, schema, { meta: { b: 3 } })).toEqual({
      meta: { a: 1, b: 3 },
    })
  })

  it('merge falls back to override when either side is not an object', () => {
    expect(applyPartial({}, schema, { meta: { a: 1 } })).toEqual({ meta: { a: 1 } })
    expect(applyPartial({ meta: { a: 1 } }, schema, { meta: 'x' })).toEqual({ meta: 'x' })
    expect(applyPartial({ meta: { a: 1 } }, schema, { meta: [1] })).toEqual({ meta: [1] })
    expect(applyPartial({ meta: 'str' }, schema, { meta: { a: 1 } })).toEqual({ meta: { a: 1 } })
  })

  it('throws on an undeclared channel', () => {
    expect(() => applyPartial({}, schema, { nope: 1 })).toThrow(/undeclared channel 'nope'/)
  })

  it('throws when an append channel holds a non-array', () => {
    expect(() => applyPartial({ notes: 'not-an-array' }, schema, { notes: 'x' })).toThrow(
      /must hold an array/,
    )
  })
})
