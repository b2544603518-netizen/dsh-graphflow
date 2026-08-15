import type { State, StateSchema } from './types.ts';
/** Build the initial state: schema defaults first, then `input` folded through the reducers. */
export declare function initialState(schema: StateSchema, input: State): State;
/** Fold one node's partial update into `state` using each channel's reducer. */
export declare function applyPartial(state: State, schema: StateSchema, partial: State): State;
