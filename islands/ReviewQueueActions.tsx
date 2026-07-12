// ReviewQueueActions (Prompt 4.3b). Resolves reconciliation candidates via
// the review-queue API: merge onto a chosen candidate, create-new with the
// analyst enrichment (criticality + business_impact — the ID.AM-05 required
// fields a scanner can't know), reject with a reason, and bulk create-new
// over the rows selected in the server-rendered table. Dialogs are native
// <dialog> opened with showModal() (focus handled by the platform).
import { useEffect, useRef, useState } from "preact/hooks";

const CRITICALITIES = ["low", "medium", "high", "mission_critical"] as const;

export interface ReviewRowItem {
  id: string;
  status: string;
  entityKind: "device" | "software";
  candidates: { entityId: string; matchedKey: string; score: number }[];
}

export interface ReviewQueueActionsProps {
  item?: ReviewRowItem;
  bulk?: boolean;
}

interface Enrichment {
  criticality: string;
  businessImpact: string;
  owner: string;
  department: string;
}

const EMPTY_ENRICHMENT: Enrichment = {
  criticality: "medium",
  businessImpact: "",
  owner: "",
  department: "",
};

async function post(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; body: unknown; status: number }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      ok: res.ok,
      body: await res.json().catch(() => null),
      status: res.status,
    };
  } catch {
    return { ok: false, body: null, status: 0 };
  }
}

function errorMessage(result: { body: unknown; status: number }): string {
  const err = (result.body as { error?: { message?: string } } | null)?.error;
  return err?.message ??
    (result.status === 0 ? "network error" : `failed (HTTP ${result.status})`);
}

function checkedItemIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[name="itemIds"]:checked',
    ),
  ).map((el) => el.value);
}

export default function ReviewQueueActions(props: ReviewQueueActionsProps) {
  const [dialog, setDialog] = useState<"create-new" | "reject" | "bulk" | null>(
    null,
  );
  const [enrichment, setEnrichment] = useState<Enrichment>(EMPTY_ENRICHMENT);
  const [reason, setReason] = useState("");
  const [candidate, setCandidate] = useState(
    props.item?.candidates[0]?.entityId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (dialog) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialog]);

  function openDialog(kind: "create-new" | "reject" | "bulk") {
    setError(null);
    setNotice(null);
    if (kind === "bulk" && checkedItemIds().length === 0) {
      setError("select at least one pending item first");
      return;
    }
    setDialog(kind);
  }

  async function run(action: () => Promise<{ done: boolean; note?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.done) {
        if (result.note) setNotice(result.note);
        else location.reload();
      }
    } finally {
      setBusy(false);
    }
  }

  const enrichmentBody = () => ({
    criticality: enrichment.criticality,
    businessImpact: enrichment.businessImpact,
    ...(enrichment.owner !== "" && { owner: enrichment.owner }),
    ...(enrichment.department !== "" && { department: enrichment.department }),
  });

  const merge = () =>
    run(async () => {
      const res = await post(
        `/api/review-queue/${props.item!.id}/merge`,
        { targetEntityId: candidate },
      );
      if (!res.ok) setError(errorMessage(res));
      return { done: res.ok };
    });

  const createNew = () =>
    run(async () => {
      const res = await post(
        `/api/review-queue/${props.item!.id}/create-new`,
        enrichmentBody(),
      );
      if (!res.ok) setError(errorMessage(res));
      return { done: res.ok };
    });

  const reject = () =>
    run(async () => {
      const res = await post(
        `/api/review-queue/${props.item!.id}/reject`,
        { reason },
      );
      if (!res.ok) setError(errorMessage(res));
      return { done: res.ok };
    });

  const bulkCreateNew = () =>
    run(async () => {
      const res = await post("/api/review-queue/bulk-create-new", {
        itemIds: checkedItemIds(),
        enrichment: enrichmentBody(),
      });
      if (!res.ok) {
        setError(errorMessage(res));
        return { done: false };
      }
      const body = res.body as {
        succeeded: string[];
        failed: { itemId: string; code: string }[];
      };
      if (body.failed.length > 0) {
        return {
          done: true,
          note:
            `${body.succeeded.length} promoted, ${body.failed.length} failed ` +
            `(${body.failed.map((f) => f.code).join(", ")})`,
        };
      }
      return { done: true };
    });

  // ---- render -------------------------------------------------------------

  if (props.bulk) {
    return (
      <div>
        <nav>
          <button
            type="button"
            class="small border"
            disabled={busy}
            onClick={() => openDialog("bulk")}
          >
            <i>library_add</i>
            <span>Bulk create new</span>
          </button>
          {notice && (
            <button
              type="button"
              class="small"
              onClick={() => location.reload()}
            >
              {notice} — refresh
            </button>
          )}
        </nav>
        {error && <p class="error-text small-text" role="alert">{error}</p>}
        <dialog ref={dialogRef} class="modal">
          <h6>Bulk create new assets</h6>
          <p class="small-text">
            One enrichment applies to every selected item (ID.AM-05).
          </p>
          <EnrichmentFields
            enrichment={enrichment}
            onChange={setEnrichment}
          />
          {error && <p class="error-text small-text" role="alert">{error}</p>}
          <nav class="right-align">
            <button
              type="button"
              class="border"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || enrichment.businessImpact === ""}
              onClick={bulkCreateNew}
            >
              Promote selected
            </button>
          </nav>
        </dialog>
      </div>
    );
  }

  const item = props.item;
  if (!item || item.status !== "pending") return null;

  return (
    <div>
      <nav class="no-space">
        {item.candidates.length > 0 && (
          <>
            {item.candidates.length > 1 && (
              <div class="field border small">
                <select
                  aria-label="Merge target"
                  value={candidate}
                  onChange={(e) =>
                    setCandidate((e.target as HTMLSelectElement).value)}
                >
                  {item.candidates.map((c) => (
                    <option value={c.entityId}>
                      {c.matchedKey.replaceAll("_", " ")} →{" "}
                      {c.entityId.slice(0, 8)}…
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button
              type="button"
              class="small border"
              disabled={busy}
              onClick={merge}
            >
              Merge
            </button>
          </>
        )}
        <button
          type="button"
          class="small border"
          disabled={busy}
          onClick={() => openDialog("create-new")}
        >
          Create new
        </button>
        <button
          type="button"
          class="small border"
          disabled={busy}
          onClick={() => openDialog("reject")}
        >
          Reject
        </button>
      </nav>
      {error && <p class="error-text small-text" role="alert">{error}</p>}

      <dialog ref={dialogRef} class="modal">
        {dialog === "create-new" && (
          <>
            <h6>Create new {item.entityKind}</h6>
            <EnrichmentFields
              enrichment={enrichment}
              onChange={setEnrichment}
            />
            {error && <p class="error-text small-text" role="alert">{error}</p>}
            <nav class="right-align">
              <button
                type="button"
                class="border"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || enrichment.businessImpact === ""}
                onClick={createNew}
              >
                Create
              </button>
            </nav>
          </>
        )}
        {dialog === "reject" && (
          <>
            <h6>Reject observation</h6>
            <div class="field label border">
              <input
                type="text"
                placeholder=" "
                value={reason}
                onInput={(e) => setReason((e.target as HTMLInputElement).value)}
              />
              <label>Reason</label>
            </div>
            {error && <p class="error-text small-text" role="alert">{error}</p>}
            <nav class="right-align">
              <button
                type="button"
                class="border"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || reason === ""}
                onClick={reject}
              >
                Reject
              </button>
            </nav>
          </>
        )}
      </dialog>
    </div>
  );
}

function EnrichmentFields(
  { enrichment, onChange }: {
    enrichment: Enrichment;
    onChange: (e: Enrichment) => void;
  },
) {
  return (
    <div class="grid">
      <div class="field label border s12 m6">
        <select
          value={enrichment.criticality}
          onChange={(e) =>
            onChange({
              ...enrichment,
              criticality: (e.target as HTMLSelectElement).value,
            })}
        >
          {CRITICALITIES.map((c) => (
            <option value={c} selected={c === enrichment.criticality}>
              {c.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <label>Criticality</label>
      </div>
      <div class="field label border s12 m6">
        <input
          type="text"
          placeholder=" "
          value={enrichment.businessImpact}
          onInput={(e) =>
            onChange({
              ...enrichment,
              businessImpact: (e.target as HTMLInputElement).value,
            })}
        />
        <label>Business impact</label>
      </div>
      <div class="field label border s12 m6">
        <input
          type="text"
          placeholder=" "
          value={enrichment.owner}
          onInput={(e) =>
            onChange({
              ...enrichment,
              owner: (e.target as HTMLInputElement).value,
            })}
        />
        <label>Owner (if source lacked it)</label>
      </div>
      <div class="field label border s12 m6">
        <input
          type="text"
          placeholder=" "
          value={enrichment.department}
          onInput={(e) =>
            onChange({
              ...enrichment,
              department: (e.target as HTMLInputElement).value,
            })}
        />
        <label>Department (if source lacked it)</label>
      </div>
    </div>
  );
}
