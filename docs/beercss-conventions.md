# Beer CSS conventions for CSAM

Repo location: `docs/beercss-conventions.md`. Companion to the vendored upstream
reference at `docs/vendor/beercss-llms.md` (Beer CSS's official llms.md, MIT
licensed, **pinned to beercss@4.0.23** — re-vendor from the matching tag when the
pin changes, never from an unpinned main branch). Agents: the vendored file is
the authoritative vocabulary for elements, helpers, and settings; this file adds
the rules for how CSAM uses them. If a class isn't in the vendored file, it
doesn't exist — do not invent helpers.

## 1. Setup in this project

Beer CSS is dependency-free CSS plus an optional small vanilla-JS enhancer. In
Fresh, import once in the app shell:

- Stylesheet: `beer.min.css` served from `static/` (vendored via the
  `assets:vendor` deno task — no runtime CDN dependency; CSP stays strict).
- `beer.min.js` and `material-dynamic-colors.min.js` are **optional**. We load
  `beer.min.js` as a static `<script type="module">` for its `data-ui` triggers
  and `ui("mode", …)` light/dark switching; we do NOT load
  `material-dynamic-colors` initially (no dynamic theme-from-image requirement).
- One Setting per document on `<body>`: `class="light"` or `class="dark"`
  (mode toggling via `ui("mode", "light|dark|auto")`).
- Exactly one `<main class="responsive">` per page.
- Icons: Material Symbols font (vendored to `static/`, not hotlinked), used as
  `<i>icon_name</i>`.

## 2. The three-part model (follow upstream DO/DON'T strictly)

Beer CSS = Settings (document-level), Elements (semantic tags, or one element
class per tag), Helpers (N modifier classes per element).

- ✅ `<button class="small primary">`, `<article class="border round">`
- 🚫 two element classes on one tag; 🚫 BEM-style child classes
  (`card-header`); 🚫 block elements inside inline elements; 🚫 more than one
  `<main>`.
- Custom CSS is a last resort: try helpers first; if custom CSS is required,
  target `.element.helper` / `.element > .element` patterns per upstream
  guidance and put it in `static/styles.css` with a comment explaining why
  helpers were insufficient.

## 3. Color usage — MD3 roles only

Use Material 3 **role helpers**, never palette-color helpers, so theming and
dark mode remain coherent:

- Roles: `primary`, `secondary`, `tertiary`, `error`, each with `-text`,
  `-border`, `-container` variants; plus `surface`, `surface-variant`,
  `inverse-surface`, `inverse-primary`, `background`, `fill`.
- 🚫 Palette helpers (`amber`, `blue`, `red4`, `green-text`, …) are forbidden in
  app code — they bypass the theme.

CSAM semantic mapping (use consistently everywhere):

| Meaning | Helpers |
|---|---|
| Primary action / brand | `primary` (buttons), `primary-container` (emphasis surfaces) |
| Authorized / healthy / passing | `tertiary-container` on badges/chips (with `tertiary-text` accents) |
| Unauthorized / error / failing sync | `error` (critical actions), `error-container` (badges, alert surfaces) |
| Pending review / stale / warning | `secondary-container` |
| Neutral chrome, cards, tables | `surface` / `surface-variant` / `border` |

Note: MD3 has no dedicated success/warning roles; the tertiary/secondary
container mapping above is our project convention — do not improvise
per-feature alternatives. If a true status ramp becomes necessary, extend the
theme via CSS variables in `static/styles.css` and document it here first.

## 4. Element cheat sheet for CSAM's recurring UI

(Names below are upstream elements — full helper lists are in the vendored
file.)

- **Tables** (inventories, provenance): `<table>` inside a scroll wrapper;
  helpers like `border`, `stripes` per vendored TABLE section. Keep sortable
  headers as plain links (server-side sort via query params).
- **Cards** (dashboard tiles, asset summary): `<article>` + `border`/`round` +
  padding helpers.
- **Badges/Chips** (authorization state, source tags): `<div class="badge">`
  overlays and `<button class="chip">` per vendored sections, colored via the
  §3 mapping.
- **Forms** (connector config, dispositions): `<div class="field label border">`
  wrappers around `<input>`/`<select>`/`<textarea>` per the vendored INPUT /
  SELECT / TEXTAREA sections; native validation attributes; errors rendered
  server-side with `error-text`.
- **Dialogs** (disposition confirmations): native `<dialog>` — Beer styles it
  directly. Prefer `method="dialog"` forms + `showModal()` from a minimal
  inline handler or `data-ui="#dialog-id"` triggers (needs `beer.min.js`).
  Component correctness must not require JS: any dialog-gated action must also
  be reachable via a plain page/form.
- **Expansion** (competing-values disclosure): native `<details>/<summary>` —
  styled by Beer out of the box, zero JS.
- **Layout**: `<nav class="left">` rail + responsive `s`/`m`/`l` visibility
  helpers for the app shell; 12-col `grid` with `s*/m*/l*` size helpers inside
  pages.
- **Feedback**: `progress`, `snackbar` (snackbar activation prefers `data-ui`;
  reserve a Preact island only if programmatic sequencing is required).

## 5. Accessibility floor

Beer CSS styles semantic HTML but does not add ARIA for you. Every hand-built
component must ship: real `<label>`s (or `aria-label` on icon-only buttons),
focus-visible states left intact, dialog focus handled by native `showModal()`,
tables with `<caption>` and `<th scope>`, and color never as the sole status
indicator (badge text accompanies badge color — required by the §3 mapping).

## 6. App-specific extensions registry

Custom CSS or theme variables added to `static/styles.css` must be recorded
here so agents treat them as allowed vocabulary.

- _None yet._
