// /devices — server-rendered device inventory (routes PRD §5.2; Safeguards
// 1.1/1.2). Filters are GET-form submissions so filtered views are shareable
// URLs and need no JS; the table is semantic Beer CSS `border stripes scroll`.
import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import type { Repositories } from "../../db/container.ts";
import type { Device, Page } from "../../db/repositories/interfaces/mod.ts";
import {
  ASSET_STATUSES,
  CRITICALITIES,
  DEVICE_CLASSES,
  ENTERPRISE_ASSET_TYPES,
  ENVIRONMENTS,
} from "../../db/repositories/interfaces/mod.ts";
import { parseDeviceListQuery, queryString } from "../(_shared)/query.ts";
import { SelectFilter, TextFilter } from "../../components/FilterFields.tsx";
import { Pagination } from "../../components/Pagination.tsx";
import { assetStatusTone, StatusBadge } from "../../components/StatusBadge.tsx";

export interface DevicesPageData {
  result: Page<Device>;
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadDevicesPage(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<DevicesPageData> {
  const parsed = parseDeviceListQuery(search);
  if (!parsed.ok) throw new HttpError(400);
  return {
    result: await repositories.devices.list(
      parsed.value.filter,
      parsed.value.page,
    ),
  };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadDevicesPage(ctx.state.repositories, ctx.url.searchParams)),
});

export default define.page<typeof handler>(function DevicesPage(props) {
  const { result } = props.data;
  const search = props.url.searchParams;
  const prevOffset = result.offset - result.limit;
  const nextOffset = result.offset + result.limit;

  return (
    <>
      <h5>Devices</h5>

      <article class="border round">
        <form method="get" action="/devices" class="grid">
          <SelectFilter
            name="status"
            label="Status"
            options={ASSET_STATUSES}
            selected={search.get("status")}
          />
          <SelectFilter
            name="deviceClass"
            label="Device class"
            options={DEVICE_CLASSES}
            selected={search.get("deviceClass")}
          />
          <SelectFilter
            name="enterpriseAssetType"
            label="Asset type"
            options={ENTERPRISE_ASSET_TYPES}
            selected={search.get("enterpriseAssetType")}
          />
          <SelectFilter
            name="environment"
            label="Environment"
            options={ENVIRONMENTS}
            selected={search.get("environment")}
          />
          <SelectFilter
            name="criticality"
            label="Criticality"
            options={CRITICALITIES}
            selected={search.get("criticality")}
          />
          <TextFilter
            name="department"
            label="Department"
            value={search.get("department")}
          />
          <TextFilter
            name="hostname"
            label="Hostname contains"
            value={search.get("hostname")}
          />
          <nav class="s12">
            <button type="submit">
              <i>filter_alt</i>
              <span>Apply filters</span>
            </button>
            <a class="button border" href="/devices">Clear</a>
          </nav>
        </form>
      </article>

      <article class="border round">
        <table class="border stripes scroll">
          <caption class="left-align">
            Device inventory — {result.total}{" "}
            device{result.total === 1 ? "" : "s"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Hostname</th>
              <th scope="col">Class / Type</th>
              <th scope="col">Environment</th>
              <th scope="col">Status</th>
              <th scope="col">Criticality</th>
              <th scope="col">Department</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 && (
              <tr>
                <td colspan={6}>No devices match the current filters.</td>
              </tr>
            )}
            {result.items.map((device) => (
              <tr>
                <td>
                  <a href={`/devices/${device.id}`}>{device.hostname}</a>
                </td>
                <td>
                  {device.deviceClass.replaceAll("_", " ")}
                  {device.enterpriseAssetType
                    ? ` / ${device.enterpriseAssetType.replaceAll("_", " ")}`
                    : ""}
                  {device.endUserDeviceSubtype
                    ? ` (${device.endUserDeviceSubtype.replaceAll("_", " ")})`
                    : ""}
                </td>
                <td>{device.environment}</td>
                <td>
                  <StatusBadge
                    label={device.status}
                    tone={assetStatusTone(device.status)}
                  />
                </td>
                <td>{device.criticality.replaceAll("_", " ")}</td>
                <td>{device.department}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          total={result.total}
          limit={result.limit}
          offset={result.offset}
          prevHref={result.offset > 0
            ? `/devices?${
              queryString(search, {
                offset: String(Math.max(prevOffset, 0)),
              })
            }`
            : null}
          nextHref={nextOffset < result.total
            ? `/devices?${queryString(search, { offset: String(nextOffset) })}`
            : null}
        />
      </article>
    </>
  );
});
