// Label/value facts table for asset detail pages — semantic rows with
// `<th scope="row">` (conventions §5), no div soup. Values may be plain
// strings or pre-rendered nodes (badges, links).
import type { ComponentChildren } from "preact";

export interface Fact {
  label: string;
  value: ComponentChildren;
}

export function FactsTable(
  { caption, facts }: { caption: string; facts: Fact[] },
) {
  return (
    <table class="border">
      <caption class="left-align">{caption}</caption>
      <tbody>
        {facts.map((fact) => (
          <tr>
            <th scope="row">{fact.label}</th>
            <td>{fact.value ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
