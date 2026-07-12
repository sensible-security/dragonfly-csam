import { createDefine } from "fresh";
import type { Repositories, Services } from "./db/container.ts";
import type { ConnectorRegistry } from "./connectors/mod.ts";
import type { AuthIdentity } from "./db/repositories/interfaces/mod.ts";

/**
 * Shape of `ctx.state` shared among middlewares, layouts and routes.
 * The composition root (db/container.ts) populates these; route handlers
 * resolve the data layer and services from here and never construct them
 * (AGENTS.md §4.1). Only interfaces + the connector registry are exposed —
 * no driver types.
 */
export interface State {
  repositories: Repositories;
  services: Services;
  registry: ConnectorRegistry;
  // Resolved by the auth middleware (services/http_auth.ts); absent only on
  // the open routes (/api/health, /login, static assets).
  identity?: AuthIdentity;
}

export const define = createDefine<State>();
