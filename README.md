# opa-rum-js

Tiny, dependency-free **Real User Monitoring beacon** for the
[OPA](https://github.com/TheGrimmChester/OPA-Agent) open profiling agent.
Drop one `<script>` tag on any page and it collects real-browser performance
and reliability data, then ships it to your OPA agent for the dashboard's
**Browser (RUM)** views.

- **Zero dependencies** · vanilla ES2017 IIFE · ~7 KB gzipped
- **Safe by construction** — every hook wraps + calls through and swallows its
  own errors; it can never break the host page
- **Privacy-aware** — query strings are stripped from beaconed URLs

## What it captures

- **Core Web Vitals** — LCP, CLS, INP, FID, FCP, TTFB (via `PerformanceObserver`)
- **Navigation timing** — TTFB, DOM ready, total load
- **Resource timing** — per-resource name, type, duration, size (capped)
- **AJAX** — `fetch()` and `XMLHttpRequest` calls with method, URL, status,
  duration (4xx/5xx and slow calls show up)
- **JavaScript errors** — uncaught errors + unhandled promise rejections
- **Sessions** — a `sessionStorage` session id + per-load page-view id

## Quick start

```html
<script
  src="/opa-rum.js"
  data-endpoint=""
  data-organization-id="YOUR_ORG_ID"
  data-project-id="YOUR_PROJECT_ID"
  data-sample-rate="1"></script>
```

Put it in `<head>` so the observers and AJAX/error hooks register early.
Leave `data-endpoint` **empty** to post to the same origin (the beacon appends
`/api/rum`); set an absolute origin when the monitored site lives elsewhere.

Or configure via a global before the script loads:

```html
<script>
  window.OPA_RUM_CONFIG = {
    endpoint: '',                // same origin
    organizationId: 'YOUR_ORG_ID',
    projectId: 'YOUR_PROJECT_ID',
    sampleRate: 1,
    debug: false
  };
</script>
<script src="/opa-rum.js"></script>
```

## Config

| `data-*` attribute      | `OPA_RUM_CONFIG` key | Default     | Meaning |
|-------------------------|----------------------|-------------|---------|
| `data-endpoint`         | `endpoint`           | same origin | Base origin the beacon POSTs to (`/api/rum` appended). |
| `data-organization-id`  | `organizationId`     | —           | Public organization id. |
| `data-project-id`       | `projectId`          | —           | Public project id. |
| `data-sample-rate`      | `sampleRate`         | `1`         | Fraction of sessions to record (`0.1` = 10%). |
| `data-debug`            | `debug`              | `false`     | Log beacon activity to the console. |

The organization/project ids are **public routing keys**, not secrets — safe to
embed in client-side HTML.

## Delivery

The beacon batches everything and POSTs JSON to `<endpoint>/api/rum` via
`navigator.sendBeacon()` when the page is hidden (`visibilitychange` → hidden,
`pagehide`), plus a one-time safety flush ~4 s after load — so short-lived tabs
still report and the final payload carries settled vitals. `fetch(keepalive)`
is the fallback. Call `window.OpaRum.flush()` manually (e.g. on SPA route
changes).

## Demo

Open [`examples/demo.html`](examples/demo.html) served next to an OPA
dashboard/agent — it generates vitals, resources, AJAX (including a deliberate
404), and JS errors, with buttons to throw an error and flush on demand.

## License

MIT © TheGrimmChester
