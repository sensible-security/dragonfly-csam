// AssetStatusToggle (Prompt 4.3a; Safeguard 1.2 / 2.3). Switches a device
// among authorized/unauthorized/quarantined — or a software entry among its
// authorization statuses — via the dedicated audited status endpoints, with
// optimistic UI and rollback + error surface on failure. Talks only to
// routes/api (AGENTS.md §6); no service/repository objects cross this line.
import { useState } from "preact/hooks";

// Local mirrors of the taxonomy vocabulary this control offers. The server
// (Zod + SQL CHECK) remains the enforcement point.
const DEVICE_STATUSES = ["authorized", "unauthorized", "quarantined"] as const;
const SOFTWARE_AUTH_STATUSES = [
  "authorized",
  "unauthorized",
  "exception_documented",
] as const;

export interface AssetStatusToggleProps {
  kind: "device" | "software";
  entityId: string;
  current: string;
}

export default function AssetStatusToggle(props: AssetStatusToggleProps) {
  const [status, setStatus] = useState(props.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: readonly string[] = props.kind === "device"
    ? DEVICE_STATUSES
    : SOFTWARE_AUTH_STATUSES;
  const endpoint = props.kind === "device"
    ? `/api/devices/${props.entityId}/status`
    : `/api/software/${props.entityId}/authorization`;

  async function transition(next: string) {
    if (busy || next === status) return;
    const previous = status;
    // Optimistic: flip immediately, roll back on failure.
    setStatus(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setStatus(previous);
        setError(
          body?.error?.message ?? `status change failed (HTTP ${res.status})`,
        );
      }
    } catch {
      setStatus(previous);
      setError("network error — status not changed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <nav>
        {options.map((option) => (
          <button
            type="button"
            class={option === status ? "small primary" : "small border"}
            disabled={busy}
            aria-pressed={option === status}
            onClick={() => transition(option)}
          >
            {option.replaceAll("_", " ")}
          </button>
        ))}
        {!options.includes(status) && (
          <span class="small-text">current: {status.replaceAll("_", " ")}</span>
        )}
      </nav>
      {error && <p class="error-text small-text" role="alert">{error}</p>}
    </div>
  );
}
