// /devices/[id] — the Safeguard 1.1 / ID.AM-05 evidence surface (routes PRD
// §5.3): identity + status, network interfaces with append-only IP history
// (newest first), installed software, field-level provenance, and the staging
// records that fed the asset. The AssetStatusToggle island replaces the
// status badge in Prompt 4.3.
import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import type { Repositories } from "../../db/container.ts";
import { buildDeviceDetail, type DeviceDetail } from "../(_shared)/detail.ts";
import { FactsTable } from "../../components/FactsTable.tsx";
import AssetStatusToggle from "../../islands/AssetStatusToggle.tsx";

export interface DeviceDetailPageData {
  detail: DeviceDetail;
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadDeviceDetailPage(
  repositories: Repositories,
  id: string,
): Promise<DeviceDetailPageData> {
  const detail = await buildDeviceDetail(repositories, id);
  if (!detail) throw new HttpError(404);
  return { detail };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadDeviceDetailPage(ctx.state.repositories, ctx.params.id)),
});

export default define.page<typeof handler>(function DeviceDetailPage(props) {
  const { device, interfaces, installations, provenance, sourceRecords } =
    props.data.detail;

  return (
    <>
      <nav>
        <a href="/devices">Devices</a>
        <i>chevron_right</i>
        <span>{device.hostname}</span>
      </nav>

      <article class="border round">
        <nav>
          <h5 class="max">{device.hostname}</h5>
          <AssetStatusToggle
            kind="device"
            entityId={device.id}
            current={device.status}
          />
        </nav>
        <FactsTable
          caption="Identity (Safeguard 1.1 / ID.AM-05)"
          facts={[
            {
              label: "Device class",
              value: device.deviceClass.replaceAll("_", " "),
            },
            {
              label: "Asset type",
              value: device.enterpriseAssetType?.replaceAll("_", " ") ?? "—",
            },
            {
              label: "End-user subtype",
              value: device.endUserDeviceSubtype?.replaceAll("_", " ") ?? "—",
            },
            { label: "Environment", value: device.environment },
            { label: "Domain", value: device.domain ?? "—" },
            { label: "Hardware serial", value: device.hardwareSerial ?? "—" },
            {
              label: "Cloud instance ID",
              value: device.cloudInstanceId ?? "—",
            },
            { label: "Owner", value: device.owner },
            { label: "Department", value: device.department },
            {
              label: "Criticality",
              value: device.criticality.replaceAll("_", " "),
            },
            { label: "Business impact", value: device.businessImpact },
            { label: "Notes", value: device.notes ?? "—" },
            { label: "Created", value: device.createdAt },
            { label: "Updated", value: device.updatedAt },
          ]}
        />
      </article>

      <article class="border round">
        <h6>Network interfaces</h6>
        {interfaces.length === 0 && <p>No interfaces recorded.</p>}
        {interfaces.map((entry) => (
          <table class="border stripes scroll">
            <caption class="left-align">
              {entry.interface.interfaceName ?? "interface"} —{" "}
              {entry.interface.macAddress}
            </caption>
            <thead>
              <tr>
                <th scope="col">IP address</th>
                <th scope="col">First seen</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {entry.ipHistory.length === 0 && (
                <tr>
                  <td colspan={3}>No IP observations.</td>
                </tr>
              )}
              {[...entry.ipHistory]
                .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
                .map((ip) => (
                  <tr>
                    <td>{ip.ipAddress}</td>
                    <td>{ip.firstSeen}</td>
                    <td>{ip.lastSeen}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ))}
      </article>

      <article class="border round">
        <h6>Installed software</h6>
        <table class="border stripes scroll">
          <caption class="left-align">
            Installations — {installations.length}
          </caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Version</th>
              <th scope="col">Install date</th>
              <th scope="col">Uninstalled</th>
            </tr>
          </thead>
          <tbody>
            {installations.length === 0 && (
              <tr>
                <td colspan={4}>No software recorded on this device.</td>
              </tr>
            )}
            {installations.map((entry) => (
              <tr>
                <td>
                  {entry.software
                    ? (
                      <a href={`/software/${entry.software.id}`}>
                        {entry.software.title}
                      </a>
                    )
                    : entry.installation.softwareId}
                </td>
                <td>{entry.software?.version ?? "—"}</td>
                <td>{entry.installation.installDate ?? "—"}</td>
                <td>{entry.installation.uninstalledAt ?? "current"}</td>
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
