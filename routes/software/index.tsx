// /software — server-rendered software inventory (routes PRD §5.4; Safeguards
// 2.1–2.3). Rows carry the EOL/unsupported flag derived from supportStatus +
// eolDate (Safeguard 2.2); filters are shareable GET-form URLs.
import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import type { Repositories } from "../../db/container.ts";
import type { Page, Software } from "../../db/repositories/interfaces/mod.ts";
import {
  CRITICALITIES,
  SOFTWARE_ASSET_TYPES,
  SOFTWARE_AUTHORIZATION_STATUSES,
  SUPPORT_STATUSES,
} from "../../db/repositories/interfaces/mod.ts";
import { parseSoftwareListQuery, queryString } from "../(_shared)/query.ts";
import { SelectFilter, TextFilter } from "../../components/FilterFields.tsx";
import { Pagination } from "../../components/Pagination.tsx";
import {
  authorizationTone,
  type BadgeTone,
  StatusBadge,
} from "../../components/StatusBadge.tsx";

export interface SoftwarePageData {
  result: Page<Software>;
}

// The Safeguard 2.2 flag: unsupported/EOL-flagged software is called out, and
// a past eolDate flags even a nominally "supported" entry.
export function supportFlag(
  software: Pick<Software, "supportStatus" | "eolDate">,
  today: string,
): { label: string; tone: BadgeTone } {
  if (software.supportStatus === "unsupported") {
    return { label: "unsupported", tone: "negative" };
  }
  if (software.supportStatus === "eol_flagged") {
    return { label: "EOL flagged", tone: "caution" };
  }
  if (software.eolDate !== null && software.eolDate <= today) {
    return { label: "EOL passed", tone: "caution" };
  }
  return { label: "supported", tone: "positive" };
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadSoftwarePage(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<SoftwarePageData> {
  const parsed = parseSoftwareListQuery(search);
  if (!parsed.ok) throw new HttpError(400);
  return {
    result: await repositories.software.list(
      parsed.value.filter,
      parsed.value.page,
    ),
  };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadSoftwarePage(ctx.state.repositories, ctx.url.searchParams)),
});

export default define.page<typeof handler>(function SoftwarePage(props) {
  const { result } = props.data;
  const search = props.url.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const prevOffset = result.offset - result.limit;
  const nextOffset = result.offset + result.limit;

  return (
    <>
      <h5>Software</h5>

      <article class="border round">
        <form method="get" action="/software" class="grid">
          <SelectFilter
            name="softwareType"
            label="Type"
            options={SOFTWARE_ASSET_TYPES}
            selected={search.get("softwareType")}
          />
          <SelectFilter
            name="authorizationStatus"
            label="Authorization"
            options={SOFTWARE_AUTHORIZATION_STATUSES}
            selected={search.get("authorizationStatus")}
          />
          <SelectFilter
            name="supportStatus"
            label="Support status"
            options={SUPPORT_STATUSES}
            selected={search.get("supportStatus")}
          />
          <SelectFilter
            name="criticality"
            label="Criticality"
            options={CRITICALITIES}
            selected={search.get("criticality")}
          />
          <TextFilter
            name="eolBefore"
            label="EOL before"
            type="date"
            value={search.get("eolBefore")}
          />
          <TextFilter
            name="title"
            label="Title contains"
            value={search.get("title")}
          />
          <nav class="s12">
            <button type="submit">
              <i>filter_alt</i>
              <span>Apply filters</span>
            </button>
            <a class="button border" href="/software">Clear</a>
          </nav>
        </form>
      </article>

      <article class="border round">
        <table class="border stripes scroll">
          <caption class="left-align">
            Software inventory — {result.total}{" "}
            entr{result.total === 1 ? "y" : "ies"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Publisher</th>
              <th scope="col">Version</th>
              <th scope="col">Type</th>
              <th scope="col">Authorization</th>
              <th scope="col">Support / EOL</th>
              <th scope="col">Criticality</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 && (
              <tr>
                <td colspan={7}>No software matches the current filters.</td>
              </tr>
            )}
            {result.items.map((software) => {
              const flag = supportFlag(software, today);
              return (
                <tr>
                  <td>
                    <a href={`/software/${software.id}`}>{software.title}</a>
                  </td>
                  <td>{software.publisher}</td>
                  <td>{software.version}</td>
                  <td>
                    {software.softwareType.replaceAll("_", " ")}
                    {software.componentType
                      ? ` / ${software.componentType}`
                      : ""}
                  </td>
                  <td>
                    <StatusBadge
                      label={software.authorizationStatus}
                      tone={authorizationTone(software.authorizationStatus)}
                    />
                  </td>
                  <td>
                    <StatusBadge label={flag.label} tone={flag.tone} />
                    {software.eolDate ? ` ${software.eolDate}` : ""}
                  </td>
                  <td>{software.criticality.replaceAll("_", " ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pagination
          total={result.total}
          limit={result.limit}
          offset={result.offset}
          prevHref={result.offset > 0
            ? `/software?${
              queryString(search, {
                offset: String(Math.max(prevOffset, 0)),
              })
            }`
            : null}
          nextHref={nextOffset < result.total
            ? `/software?${queryString(search, { offset: String(nextOffset) })}`
            : null}
        />
      </article>
    </>
  );
});
