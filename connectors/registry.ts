// Connector registry (PRD §4). Maps sourceType → Connector. IngestionService
// resolves the connector for a run from here; push routes look it up by the
// {sourceType} path segment. Adding a connector = register one object; no
// service edits (open/closed).
import type { Connector, SourceType } from "./types.ts";

export class ConnectorRegistry {
  #byType = new Map<SourceType, Connector>();

  register(connector: Connector): this {
    if (this.#byType.has(connector.sourceType)) {
      throw new Error(
        `a connector is already registered for source type "${connector.sourceType}"`,
      );
    }
    this.#byType.set(connector.sourceType, connector);
    return this;
  }

  get(sourceType: SourceType): Connector | undefined {
    return this.#byType.get(sourceType);
  }

  // Throws (rather than returning undefined) for the resolve-or-fail path in
  // IngestionService, where an unknown source type is a programmer/config error.
  require(sourceType: SourceType): Connector {
    const connector = this.#byType.get(sourceType);
    if (!connector) {
      throw new Error(
        `no connector registered for source type "${sourceType}"`,
      );
    }
    return connector;
  }

  has(sourceType: SourceType): boolean {
    return this.#byType.has(sourceType);
  }

  list(): Connector[] {
    return [...this.#byType.values()];
  }
}
