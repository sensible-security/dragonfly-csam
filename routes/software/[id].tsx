// /software/[id] — software detail (routes PRD §5.5; Safeguards 2.1–2.3):
// catalog facts, installations with host hostnames, active documented
// exceptions, field provenance, and staging records. The authorization
// toggle island arrives in Prompt 4.3.
import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import type { Repositories } from "../../db/container.ts";
import {
  buildSoftwareDetail,
  type SoftwareDetail,
} from "../(_shared)/detail.ts";
import { FactsTable } from "../../components/FactsTable.tsx";
import { StatusBadge, supportTone } from "../../components/StatusBadge.tsx";
import AssetStatusToggle from "../../islands/AssetStatusToggle.tsx";

export interface SoftwareDetailPageData {
  detail: SoftwareDetail;
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadSoftwareDetailPage(
  repositories: Repositories,
  id: string,
): Promise<SoftwareDetailPageData> {
  const detail = await buildSoftwareDetail(repositories, id);
  if (!detail) throw new HttpError(404);
  return { detail };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadSoftwareDetailPage(ctx.state.repositories, ctx.params.id)),
});

export default define.page<typeof handler>(function SoftwareDetailPage(props) {
  const { software, installations, exceptions, provenance, sourceRecords } =
    props.data.detail;

  return (
    <>
      <nav>
        <a href="/software">Software</a>
        <i>chevron_right</i>
        <span>{software.title}</span>
      </nav>

      <article class="border round">
        <nav>
          <h5 class="max">{software.title}</h5>
          <AssetStatusToggle
            kind="software"
            entityId={software.id}
            current={software.authorizationStatus}
          />
          <StatusBadge
            label={software.supportStatus}
            tone={supportTone(software.supportStatus)}
          />
        </nav>
        <FactsTable
          caption="Catalog entry (Safeguard 2.1 / ID.AM-02)"
          facts={[
            { label: "Publisher", value: software.publisher },
            { label: "Version", value: software.version },
            {
              label: "Type",
              value: software.softwareType.replaceAll("_", " "),
            },
            { label: "Component type", value: software.componentType ?? "—" },
            { label: "Business purpose", value: software.businessPurpose },
            {
              label: "URL",
              value: software.url ?? "—",
            },
            {
              label: "Deployment mechanism",
              value: software.deploymentMechanism ?? "—",
            },
            {
              label: "License count",
              value: software.licenseCount?.toString() ?? "—",
            },
            { label: "CPE", value: software.cpe ?? "—" },
            { label: "EOL date", value: software.eolDate ?? "—" },
            {
              label: "Decommission date",
              value: software.decommissionDate ?? "—",
            },
            {
              label: "Criticality",
              value: software.criticality.replaceAll("_", " "),
            },
            { label: "Business impact", value: software.businessImpact },
            { label: "Created", value: software.createdAt },
            { label: "Updated", value: software.updatedAt },
          ]}
        />
      </article>

      <article class="border round">
        <h6>Installations</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Devices with this software — {installations.length}
          </caption>
          <thead>
            <tr>
              <th scope="col">Hostname</th>
              <th scope="col">Install date</th>
              <th scope="col">Uninstalled</th>
            </tr>
          </thead>
          <tbody>
            {installations.length === 0 && (
              <tr>
                <td colspan={3}>No recorded installations.</td>
              </tr>
            )}
            {installations.map((entry) => (
              <tr>
                <td>
                  {entry.device
                    ? (
                      <a href={`/devices/${entry.device.id}`}>
                        {entry.device.hostname}
                      </a>
                    )
                    : entry.installation.deviceId}
                </td>
                <td>{entry.installation.installDate ?? "—"}</td>
                <td>{entry.installation.uninstalledAt ?? "current"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article class="border round">
        <h6>Documented exceptions</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Active exceptions (Safeguards 2.2 / 2.3)
          </caption>
          <thead>
            <tr>
              <th scope="col">Justification</th>
              <th scope="col">Approved by</th>
              <th scope="col">Review by</th>
            </tr>
          </thead>
          <tbody>
            {exceptions.length === 0 && (
              <tr>
                <td colspan={3}>No active exceptions.</td>
              </tr>
            )}
            {exceptions.map((exception) => (
              <tr>
                <td>{exception.justification}</td>
                <td>{exception.approvedBy}</td>
                <td>{exception.reviewBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article class="border round">
        <h6>Field provenance</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Which source last set each canonical field
          </caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Source</th>
              <th scope="col">Observed at</th>
            </tr>
          </thead>
          <tbody>
            {provenance.length === 0 && (
              <tr>
                <td colspan={3}>No field provenance recorded.</td>
              </tr>
            )}
            {provenance.map((entry) => (
              <tr>
                <td>{entry.field.fieldName}</td>
                <td>{entry.sourceName ?? entry.field.sourceId}</td>
                <td>{entry.field.observedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article class="border round">
        <h6>Staging records</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Source observations reconciled onto this asset
          </caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">External ID</th>
              <th scope="col">First seen</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sourceRecords.length === 0 && (
              <tr>
                <td colspan={4}>No staging records reference this asset.</td>
              </tr>
            )}
            {sourceRecords.map((entry) => (
              <tr>
                <td>{entry.sourceName ?? entry.record.sourceId}</td>
                <td>{entry.record.externalId}</td>
                <td>{entry.record.firstSeen}</td>
                <td>{entry.record.lastSeen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </>
  );
});
