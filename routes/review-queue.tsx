// /review-queue — the reconciliation review queue (routes PRD §5.6): nothing
// ambiguous is ever auto-merged (AGENTS.md §4.2), so this table is where a
// human drains it. GET-form filters + sort links keep views shareable;
// resolution actions are the ReviewQueueActions island (Prompt 4.3).
import { HttpError, page } from "fresh";
import { define } from "../utils.ts";
import type { Services } from "../db/container.ts";
import type {
  Page,
  ReviewQueueItem,
} from "../db/repositories/interfaces/mod.ts";
import {
  PROVENANCE_ENTITY_TYPES,
  REVIEW_CONFIDENCES,
  REVIEW_REASONS,
  REVIEW_STATUSES,
} from "../db/repositories/interfaces/mod.ts";
import { parseReviewQueueQuery, queryString } from "./(_shared)/query.ts";
import { SelectFilter } from "../components/FilterFields.tsx";
import { Pagination } from "../components/Pagination.tsx";
import ReviewQueueActions from "../islands/ReviewQueueActions.tsx";

export interface ReviewQueuePageData {
  result: Page<ReviewQueueItem>;
}

// Exported for direct unit testing without booting the Fresh app.
export async function loadReviewQueuePage(
  services: Services,
  search: URLSearchParams,
): Promise<ReviewQueuePageData> {
  const parsed = parseReviewQueueQuery(search);
  if (!parsed.ok) throw new HttpError(400);
  return {
    result: await services.review.list(
      parsed.value.filter,
      parsed.value.sort,
      parsed.value.page,
    ),
  };
}

export const handler = define.handlers({
  GET: async (ctx) =>
    page(await loadReviewQueuePage(ctx.state.services, ctx.url.searchParams)),
});

function attributeSummary(item: ReviewQueueItem): string {
  const entries = Object.entries(item.attributes)
    .filter(([, v]) => v !== null && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return entries.length > 0 ? entries.join(", ") : "—";
}

export default define.page<typeof handler>(function ReviewQueuePage(props) {
  const { result } = props.data;
  const search = props.url.searchParams;
  const nextOffset = result.offset + result.limit;

  const sortLink = (by: string): string => {
    const currentBy = search.get("sortBy") ?? "createdAt";
    const currentDir = search.get("sortDir") ?? "desc";
    const dir = currentBy === by && currentDir === "asc" ? "desc" : "asc";
    return `/review-queue?${
      queryString(search, { sortBy: by, sortDir: dir, offset: "0" })
    }`;
  };

  return (
    <>
      <h5>Review Queue</h5>

      <article class="border round">
        <form method="get" action="/review-queue" class="grid">
          <SelectFilter
            name="status"
            label="Status"
            options={REVIEW_STATUSES}
            selected={search.get("status")}
          />
          <SelectFilter
            name="entityKind"
            label="Entity kind"
            options={PROVENANCE_ENTITY_TYPES}
            selected={search.get("entityKind")}
          />
          <SelectFilter
            name="reason"
            label="Reason"
            options={REVIEW_REASONS}
            selected={search.get("reason")}
          />
          <SelectFilter
            name="confidence"
            label="Confidence"
            options={REVIEW_CONFIDENCES}
            selected={search.get("confidence")}
          />
          <nav class="s12">
            <button type="submit">
              <i>filter_alt</i>
              <span>Apply filters</span>
            </button>
            <a class="button border" href="/review-queue">Clear</a>
          </nav>
        </form>
      </article>

      <article class="border round">
        <ReviewQueueActions bulk />
        <table class="border stripes scroll">
          <caption class="left-align">
            Review queue — {result.total} item{result.total === 1 ? "" : "s"}
            {" "}
            (default view: pending)
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span aria-hidden="true">Select</span>
              </th>
              <th scope="col">Observation</th>
              <th scope="col">
                <a href={sortLink("entityKind")}>Kind</a>
              </th>
              <th scope="col">
                <a href={sortLink("reason")}>Reason</a>
              </th>
              <th scope="col">
                <a href={sortLink("confidence")}>Confidence</a>
              </th>
              <th scope="col">Candidates</th>
              <th scope="col">
                <a href={sortLink("createdAt")}>Created</a>
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 && (
              <tr>
                <td colspan={8}>No review items match the current filters.</td>
              </tr>
            )}
            {result.items.map((item) => (
              <tr>
                <td>
                  <label class="checkbox">
                    <input
                      type="checkbox"
                      name="itemIds"
                      value={item.id}
                      disabled={item.status !== "pending"}
                      aria-label={`Select ${attributeSummary(item)}`}
                    />
                    <span></span>
                  </label>
                </td>
                <td>{attributeSummary(item)}</td>
                <td>{item.entityKind}</td>
                <td>{item.reason.replaceAll("_", " ")}</td>
                <td>{item.confidence}</td>
                <td>{item.candidates.length}</td>
                <td>{item.createdAt}</td>
                <td>
                  {item.status === "pending"
                    ? (
                      <ReviewQueueActions
                        item={{
                          id: item.id,
                          status: item.status,
                          entityKind: item.entityKind,
                          candidates: item.candidates.map((c) => ({
                            entityId: c.entityId,
                            matchedKey: c.matchedKey,
                            score: c.score,
                          })),
                        }}
                      />
                    )
                    : item.status.replaceAll("_", " ")}
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
            ? `/review-queue?${
              queryString(search, {
                offset: String(Math.max(result.offset - result.limit, 0)),
              })
            }`
            : null}
          nextHref={nextOffset < result.total
            ? `/review-queue?${
              queryString(search, { offset: String(nextOffset) })
            }`
            : null}
        />
      </article>
    </>
  );
});
