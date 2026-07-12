import { define } from "../utils.ts";

const NAV_ITEMS = [
  { href: "/", icon: "dashboard", label: "Dashboard" },
  { href: "/devices", icon: "devices", label: "Devices" },
  { href: "/software", icon: "apps", label: "Software" },
  { href: "/ingestion", icon: "cloud_upload", label: "Ingestion" },
  { href: "/review-queue", icon: "rule", label: "Review Queue" },
  { href: "/audit-log", icon: "receipt_long", label: "Audit Log" },
] as const;

/**
 * App shell per AGENTS.md §6 and docs/beercss-conventions.md: left nav
 * drawer (rail on medium, bottom tabs on small), top app bar, one
 * responsive main. Beer CSS assets are vendored — no CDN at runtime.
 */
export default define.page(function App({ Component }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Dragonfly CSAM</title>
        <link rel="stylesheet" href="/vendor/beercss/beer.min.css" />
        <link rel="stylesheet" href="/styles.css" />
        <script type="module" src="/vendor/beercss/beer.min.js"></script>
      </head>
      <body class="light">
        <nav class="left max l">
          <header>
            <nav>
              <i class="extra">hub</i>
              <h6>Dragonfly CSAM</h6>
            </nav>
          </header>
          {NAV_ITEMS.map((item) => (
            <a href={item.href}>
              <i>{item.icon}</i>
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <nav class="left m">
          {NAV_ITEMS.map((item) => (
            <a href={item.href}>
              <i>{item.icon}</i>
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <nav class="bottom s">
          {NAV_ITEMS.map((item) => (
            <a href={item.href} aria-label={item.label}>
              <i>{item.icon}</i>
            </a>
          ))}
        </nav>

        <header class="fixed">
          <nav>
            <h5 class="max">Dragonfly CSAM</h5>
          </nav>
        </header>

        <main class="responsive">
          <Component />
        </main>
      </body>
    </html>
  );
});
