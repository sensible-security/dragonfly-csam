// Prev/next pagination for inventory tables (routes PRD §5: pagination via
// query links, so paged views stay shareable URLs). Pure presentation — the
// page computes the hrefs; null means "no such page".
export interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  prevHref: string | null;
  nextHref: string | null;
}

export function Pagination(
  { total, limit, offset, prevHref, nextHref }: PaginationProps,
) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <nav class="right-align">
      <span>{from}–{to} of {total}</span>
      {prevHref
        ? <a class="button border" href={prevHref}>Previous</a>
        : <button type="button" class="border" disabled>Previous</button>}
      {nextHref
        ? <a class="button border" href={nextHref}>Next</a>
        : <button type="button" class="border" disabled>Next</button>}
    </nav>
  );
}
