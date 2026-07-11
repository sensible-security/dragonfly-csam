import { App, staticFiles } from "fresh";
import { type State } from "./utils.ts";
import { getContainer } from "./db/container.ts";

export const app = new App<State>();

app.use(staticFiles());

// Composition root: build the single process-wide container (opens the
// connection, applies migrations on boot) and expose its repository bundle on
// ctx.state so route handlers resolve the data layer instead of constructing
// it (AGENTS.md §4.1).
const container = await getContainer();
app.use((ctx) => {
  ctx.state.repositories = container.repositories;
  ctx.state.services = container.services;
  ctx.state.registry = container.registry;
  return ctx.next();
});

// File-system based routes (routes/).
app.fsRoutes();
