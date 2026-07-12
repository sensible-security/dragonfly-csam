// /ingestion — CSV upload + recent connector runs (routes PRD §5.7). The
// upload → column-map → error-report flow is the CsvImportUploader island
// (Prompt 4.3); batches render server-side with links to each error report.
import { page } from "fresh";
import { define } from "../utils.ts";
import type { Repositories } from "../db/container.ts";
import type { IngestionBatch } from "../db/repositories/interfaces/mod.ts";
import CsvImportUploader from "../islands/CsvImportUploader.tsx";

export interface IngestionPageData {
  batches: { batch: IngestionBatch; sourceName: string | null }[];
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadIngestionPage(
  repositories: Repositories,
): Promise<IngestionPageData> {
  const recent = await repositories.ingestionBatches.listRecent(20);
  const names = new Map<string, string | null>();
  const batches: IngestionPageData["batches"] = [];
  for (const batch of recent) {
    if (!names.has(batch.sourceId)) {
      const source = await repositories.sourceRecords.getSourceById(
        batch.sourceId,
      );
      names.set(batch.sourceId, source?.name ?? null);
    }
    batches.push({ batch, sourceName: names.get(batch.sourceId) ?? null });
  }
  return { batches };
}

export const handler = define.handlers({
  GET: async (ctx) => page(await loadIngestionPage(ctx.state.repositories)),
});

export default define.page<typeof handler>(function IngestionPage(props) {
  const { batches } = props.data;

  return (
    <>
      <h5>Ingestion</h5>

      <article class="border round">
        <h6>CSV bulk import</h6>
        <p>
          Upload a CSV, map its columns to canonical device fields, and review
          the per-row error report. Malformed rows quarantine — they never reach
          the inventory.
        </p>
        <CsvImportUploader />
      </article>

      <article class="border round">
        <h6>Recent batches</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Last {batches.length} connector runs
          </caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Source</th>
              <th scope="col">Connector</th>
              <th scope="col">Status</th>
              <th scope="col">Rows</th>
              <th scope="col">Staged</th>
              <th scope="col">Quarantined</th>
              <th scope="col">Error report</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr>
                <td colspan={8}>No ingestion batches yet.</td>
              </tr>
            )}
            {batches.map((entry) => (
              <tr>
                <td>{entry.batch.startedAt}</td>
                <td>{entry.sourceName ?? entry.batch.sourceId}</td>
                <td>{entry.batch.connectorId}</td>
                <td>{entry.batch.status}</td>
                <td>{entry.batch.totalRows}</td>
                <td>{entry.batch.stagedCount}</td>
                <td>{entry.batch.quarantinedCount}</td>
                <td>
                  {entry.batch.quarantinedCount > 0
                    ? (
                      <a
                        href={`/api/ingestion-batches/${entry.batch.id}/errors`}
                      >
                        Download CSV
                      </a>
                    )
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </>
  );
});
