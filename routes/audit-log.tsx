// /audit-log — read-only audit viewer (routes PRD §5.8; AGENTS.md §4.4 / CIS
// Control 8 front-load). GET-form filters map to AuditFilter; before/after
// diffs render as inert text inside <details> (never interpreted).
import { HttpError, page } from "fresh";
import { define } from "../utils.ts";
import type { Repositories } from "../db/container.ts";
import type { AuditEntry, Page } from "../db/repositories/interfaces/mod.ts";
import { AUDIT_ACTIONS } from "../db/repositories/interfaces/mod.ts";
import { parseAuditListQuery, queryString } from "./(_shared)/query.ts";
import { SelectFilter, TextFilter } from "../components/FilterFields.tsx";
import { Pagination } from "../components/Pagination.tsx";

export interface AuditLogPageData {
  result: Page<AuditEntry>;
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadAuditLogPage(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<AuditLogPageData> {
  const parsed = parseAuditListQuery(search);
  if (!parsed.ok) throw new HttpError(400);
  return {
    result: await repositories.auditLog.query(
      parsed.value.filter,
      parsed.value.page,
    ),
  };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadAuditLogPage(ctx.state.repositories, ctx.url.searchParams)),
});

function Diff({ entry }: { entry: AuditEntry }) {
  if (entry.beforeJson === null && entry.afterJson === null) return <>—</>;
  return (
    <details>
      <summary>diff</summary>
      {entry.beforeJson !== null && (
        <>
          <p class="small-text">before</p>
          <pre class="border scroll">{entry.beforeJson}</pre>
        </>
      )}
      {entry.afterJson !== null && (
        <>
          <p class="small-text">after</p>
          <pre class="border scroll">{entry.afterJson}</pre>
        </>
      )}
    </details>
  );
}

export default define.page<typeof handler>(function AuditLogPage(props) {
  const { result } = props.data;
  const search = props.url.searchParams;
  const nextOffset = result.offset + result.limit;

  return (
    <>
      <h5>Audit Log</h5>

      <article class="border round">
        <form method="get" action="/audit-log" class="grid">
          <TextFilter
            name="entityType"
            label="Entity type"
            value={search.get("entityType")}
          />
          <TextFilter
            name="entityId"
            label="Entity ID"
            value={search.get("entityId")}
          />
          <TextFilter
            name="actorId"
            label="Actor"
            value={search.get("actorId")}
          />
          <SelectFilter
            name="action"
            label="Action"
            options={AUDIT_ACTIONS}
            selected={search.get("action")}
          />
          <TextFilter
            name="occurredAfter"
            label="Occurred after"
            type="date"
            value={search.get("occurredAfter")}
          />
          <TextFilter
            name="occurredBefore"
            label="Occurred before"
            type="date"
            value={search.get("occurredBefore")}
          />
          <nav class="s12">
            <button type="submit">
              <i>filter_alt</i>
              <span>Apply filters</span>
            </button>
            <a class="button border" href="/audit-log">Clear</a>
          </nav>
        </form>
      </article>

      <article class="border round">
        <table class="border stripes scroll">
          <caption class="left-align">
            Audit log — {result.total} entr{result.total === 1 ? "y" : "ies"}
            {" "}
            (append-only)
          </caption>
          <thead>
            <tr>
              <th scope="col">Occurred</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Source address</th>
              <th scope="col">Diff</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 && (
              <tr>
                <td colspan={6}>No audit entries match the current filters.</td>
              </tr>
            )}
            {result.items.map((entry) => (
              <tr>
                <td>{entry.occurredAt}</td>
                <td>{entry.actorType}/{entry.actorId}</td>
                <td>{entry.action.replaceAll("_", " ")}</td>
                <td>{entry.entityType} {entry.entityId}</td>
                <td>{entry.sourceAddress ?? "—"}</td>
                <td>
                  <Diff entry={entry} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          total={result.total}
          limit={result.limit}
          offset={result.offset}
          prevHref={result.offset > 0
            ? `/audit-log?${
              queryString(search, {
                offset: String(Math.max(result.offset - result.limit, 0)),
              })
            }`
            : null}
          nextHref={nextOffset < result.total
            ? `/audit-log?${
              queryString(search, { offset: String(nextOffset) })
            }`
            : null}
        />
      </article>
    </>
  );
});
