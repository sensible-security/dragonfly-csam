import { define } from "../utils.ts";

export default define.page(function IngestionPage() {
  return (
    <article class="border round">
      <h5>Ingestion</h5>
      <p>
        Connector pipeline (Source → Normalize → Stage → Reconcile → Merge →
        Inventory) arrives in Phase 3.
      </p>
    </article>
  );
});
