import { createDefine } from "fresh";
import type { Repositories } from "./db/container.ts";

/**
 * Shape of `ctx.state` shared among middlewares, layouts and routes.
 * The composition root (db/container.ts) populates `repositories`; route
 * handlers resolve the data layer from here and never construct it
 * (AGENTS.md §4.1). Only the interface bundle is exposed — no driver types.
 */
export interface State {
  repositories: Repositories;
}

export const define = createDefine<State>();
