import { cloneJson, isJsonObject } from './json.ts'
import type { JsonValue, State, StateChannel, StateSchema } from './types.ts'

/** Build the initial state: schema defaults first, then `input` folded through the reducers. */
export function initialState(schema: StateSchema, input: State): State {
  const state: Record<string, JsonValue> = {}
  for (const [key, channel] of Object.entries(schema)) {
    if (channel.default !== undefined) state[key] = cloneJson(channel.default)
  }
  return applyPartial(state, schema, input)
}

/** Fold one node's partial update into `state` using each channel's reducer. */
export function applyPartial(state: State, schema: StateSchema, partial: State): State {
  const next: Record<string, JsonValue> = { ...state }
  for (const [key, value] of Object.entries(partial)) {
    const channel = schema[key]
    if (channel === undefined) {
      throw new Error(`State update references an undeclared channel '${key}'.`)
    }
    next[key] = reduce(channel, key, next[key], value)
  }
  return next
}

function reduce(
  channel: StateChannel,
  key: string,
  previous: JsonValue | undefined,
  next: JsonValue,
): JsonValue {
  switch (channel.reducer) {
    case 'override':
      return cloneJson(next)
    case 'append':
      return append(key, previous, next)
    case 'merge':
      return merge(previous, next)
  }
}

function append(key: string, previous: JsonValue | undefined, next: JsonValue): JsonValue {
  if (previous === undefined) {
    return Array.isArray(next) ? next.map(cloneJson) : [cloneJson(next)]
  }
  if (!Array.isArray(previous)) {
    throw new Error(`Append channel '${key}' must hold an array.`)
  }
  const items = Array.isArray(next) ? next : [next]
  return [...previous, ...items.map(cloneJson)]
}

function merge(previous: JsonValue | undefined, next: JsonValue): JsonValue {
  if (previous === undefined || !isJsonObject(previous) || !isJsonObject(next)) {
    return cloneJson(next)
  }
  return { ...previous, ...cloneJson(next) }
}
