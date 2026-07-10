import { createDefine } from "fresh";

/**
 * Shape of `ctx.state` shared among middlewares, layouts and routes.
 * The composition root (Phase 2) will populate this with the service
 * instances that route handlers resolve (AGENTS.md §4.1).
 */
// deno-lint-ignore no-empty-interface
export interface State {}

export const define = createDefine<State>();
