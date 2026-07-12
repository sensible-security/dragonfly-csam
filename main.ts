import { App, staticFiles } from "fresh";
import { type State } from "./utils.ts";
import { getContainer } from "./db/container.ts";
import { guardRequest } from "./services/http_auth.ts";

export const app = new App<State>();

app.use(staticFiles());

// Composition root: build the single process-wide container (opens the
// connection, applies migrations on boot) and expose its repository bundle on
// ctx.state so route handlers resolve the data layer instead of constructing
// it (AGENTS.md §4.1).
const container = await getContainer();

// First-boot admin seeding (auth PRD Assumption 7): creates the initial admin
// from DRAGONFLY_ADMIN_USERNAME/PASSWORD when the users table is empty.
await container.services.auth.bootstrapAdminFromEnv();

app.use((ctx) => {
  ctx.state.repositories = container.repositories;
  ctx.state.services = container.services;
  ctx.state.registry = container.registry;
  return ctx.next();
});

// Authentication gate (auth PRD §3/§6): every request past staticFiles()
// resolves to an identity — session cookie everywhere, API key on
// /api/ingest/ — or is answered 401/303 here. Handlers never re-derive
// identity from headers.
app.use(async (ctx) => {
  const result = await guardRequest(ctx.req, container.services.auth);
  if (result.kind === "response") return result.response;
  ctx.state.identity = result.identity;
  return ctx.next();
});

// File-system based routes (routes/).
app.fsRoutes();
