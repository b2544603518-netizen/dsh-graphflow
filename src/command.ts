import { END, type NodeId, type State } from './types.ts'

/**
 * A node's result that also controls routing, mirroring LangGraph's `Command`.
 * `update` folds into graph state through the channel reducers; `goto` selects
 * the next node (or `END`) and overrides the node's declared edge.
 *
 * Either field is optional: a `Command({ goto })` re-routes without touching
 * state, and a `Command({ update })` updates state while still following the
 * node's edge.
 */
export class Command {
  readonly update: State | undefined
  readonly goto: NodeId | typeof END | undefined

  constructor(options: { update?: State; goto?: NodeId | typeof END } = {}) {
    this.update = options.update
    this.goto = options.goto
  }
}
