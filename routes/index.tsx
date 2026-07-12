// / — dashboard KPI cards (routes PRD §5.1, gate decision 4). Counts derive
// from filtered list() totals (§Assumption 9 — no bespoke aggregate query);
// every card links to the corresponding filtered inventory/queue view so the
// number is one click from its evidence.
import { page } from "fresh";
import { define } from "../utils.ts";
import type { Repositories, Services } from "../db/container.ts";
import type { IngestionBatch } from "../db/repositories/interfaces/mod.ts";
import {
  ASSET_STATUSES,
  CRITICALITIES,
} from "../db/repositories/interfaces/mod.ts";
import type {
  AssetStatus,
  Criticality,
} from "../db/repositories/interfaces/mod.ts";

const ONE = { limit: 1, offset: 0 };

export interface DashboardData {
  totalDevices: number;
  totalSoftware: number;
  devicesByStatus: Record<AssetStatus, number>;
  devicesByCriticality: Record<Criticality, number>;
  unauthorizedSoftware: number;
  eolOrUnsupportedSoftware: number;
  pendingReview: number;
  recentBatches: { batch: IngestionBatch; sourceName: string | null }[];
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadDashboard(
  repositories: Repositories,
  services: Services,
): Promise<DashboardData> {
  const totalDevices = (await repositories.devices.list({}, ONE)).total;
  const totalSoftware = (await repositories.software.list({}, ONE)).total;

  const devicesByStatus = {} as Record<AssetStatus, number>;
  for (const status of ASSET_STATUSES) {
    devicesByStatus[status] =
      (await repositories.devices.list({ status }, ONE)).total;
  }

  const devicesByCriticality = {} as Record<Criticality, number>;
  for (const criticality of CRITICALITIES) {
    devicesByCriticality[criticality] =
      (await repositories.devices.list({ criticality }, ONE)).total;
  }

  const unauthorizedSoftware = (await repositories.software.list(
    { authorizationStatus: "unauthorized" },
    ONE,
  )).total;
  const eolOrUnsupportedSoftware = (await repositories.software.list(
    { supportStatus: "unsupported" },
    ONE,
  )).total +
    (await repositories.software.list({ supportStatus: "eol_flagged" }, ONE))
      .total;

  // ReviewQueueFilter defaults to pending when status is omitted.
  const pendingReview =
    (await services.review.list({}, { by: "createdAt", dir: "desc" }, ONE))
      .total;

  const batches = await repositories.ingestionBatches.listRecent(5);
  const names = new Map<string, string | null>();
  const recentBatches: DashboardData["recentBatches"] = [];
  for (const batch of batches) {
    if (!names.has(batch.sourceId)) {
      const source = await repositories.sourceRecords.getSourceById(
        batch.sourceId,
      );
      names.set(batch.sourceId, source?.name ?? null);
    }
    recentBatches.push({
      batch,
      sourceName: names.get(batch.sourceId) ?? null,
    });
  }

  return {
    totalDevices,
    totalSoftware,
    devicesByStatus,
    devicesByCriticality,
    unauthorizedSoftware,
    eolOrUnsupportedSoftware,
    pendingReview,
    recentBatches,
  };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadDashboard(ctx.state.repositories, ctx.state.services)),
});

function KpiCard(
  { value, label, href }: { value: number; label: string; href: string },
) {
  return (
    <article class="border round s12 m6 l3">
      <h3>{value}</h3>
      <p>{label}</p>
      <nav>
        <a class="button border small" href={href}>View</a>
      </nav>
    </article>
  );
}

export default define.page<typeof handler>(function DashboardPage(props) {
  const data = props.data;

  return (
    <>
      <h5>Dashboard</h5>

      <div class="grid">
        <KpiCard value={data.totalDevices} label="Devices" href="/devices" />
        <KpiCard value={data.totalSoftware} label="Software" href="/software" />
        <KpiCard
          value={data.pendingReview}
          label="Pending review"
          href="/review-queue"
        />
        <KpiCard
          value={data.unauthorizedSoftware}
          label="Unauthorized software"
          href="/software?authorizationStatus=unauthorized"
        />
      </div>

      <div class="grid">
        {ASSET_STATUSES.map((status) => (
          <KpiCard
            value={data.devicesByStatus[status]}
            label={`Devices ${status.replaceAll("_", " ")}`}
            href={`/devices?status=${status}`}
          />
        ))}
        <KpiCard
          value={data.eolOrUnsupportedSoftware}
          label="EOL / unsupported software"
          href="/software?supportStatus=eol_flagged"
        />
      </div>

      <div class="grid">
        {CRITICALITIES.map((criticality) => (
          <KpiCard
            value={data.devicesByCriticality[criticality]}
            label={`Criticality: ${criticality.replaceAll("_", " ")}`}
            href={`/devices?criticality=${criticality}`}
          />
        ))}
      </div>

      <article class="border round">
        <h6>Recent ingestion batches</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Last {data.recentBatches.length} connector runs
          </caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Source</th>
              <th scope="col">Connector</th>
              <th scope="col">Status</th>
              <th scope="col">Staged</th>
              <th scope="col">Quarantined</th>
            </tr>
          </thead>
          <tbody>
            {data.recentBatches.length === 0 && (
              <tr>
                <td colspan={6}>No ingestion batches yet.</td>
              </tr>
            )}
            {data.recentBatches.map((entry) => (
              <tr>
                <td>{entry.batch.startedAt}</td>
                <td>{entry.sourceName ?? entry.batch.sourceId}</td>
                <td>{entry.batch.connectorId}</td>
                <td>{entry.batch.status}</td>
                <td>{entry.batch.stagedCount}</td>
                <td>{entry.batch.quarantinedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <nav>
          <a class="button border" href="/ingestion">Go to ingestion</a>
        </nav>
      </article>
    </>
  );
});
