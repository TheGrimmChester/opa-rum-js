# opa-rum-js

Tiny, dependency-free **Real User Monitoring beacon** for the
[OPA](https://github.com/TheGrimmChester/OPA-Agent) open profiling agent.
Drop one `<script>` tag on any page and it collects real-browser performance
and reliability data, then ships it to your OPA agent for the dashboard's
**Browser (RUM)** views.

- **Zero dependencies** · vanilla ES2017 IIFE · ~6 KB gzipped (20 KB raw)
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
- **Sessions** — a `sessionStorage` session id + per-page-view id, rotated on
  SPA route changes
- **Trace correlation** — eligible AJAX calls carry a W3C `traceparent` header
  and record the trace id, linking a slow browser call to the backend trace

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
| `data-ingest-key`       | `ingestKey`          | —           | Project ingest key (query + body; required when agent auth is on). |
| `data-sample-rate`      | `sampleRate`         | `1`         | Fraction of sessions to record (`0.1` = 10%). |
| `data-debug`            | `debug`              | `false`     | Log beacon activity to the console. |
| `data-trace-propagation-targets` | `tracePropagationTargets` | `[]` (same-origin only) | Extra origins/prefixes allowed to receive the `traceparent` header. Comma-separated in the attribute form, an array in `OPA_RUM_CONFIG`. |

The organization/project ids are **public routing keys**. The ingest key is a
site-scoped token (still required when the agent has `OPA_INGEST_AUTH_REQUIRED=1`);
it is sent in the beacon query string and JSON body because `sendBeacon` cannot
set `Authorization` headers.

## Trace correlation

Eligible AJAX calls (`fetch` and `XMLHttpRequest`) get a W3C trace context:

```
traceparent: 00-<32-hex trace id>-<16-hex span id>-01
```

The same trace id is stored on the call's `ajax_requests` entry, so the
dashboard can take you from a slow browser request straight to the backend
trace that served it. A `traceparent` your own code already set is left alone.

**Eligibility is same-origin by default.** Cross-origin requests are only
traced when their URL starts with one of `tracePropagationTargets`, because
sending the header to a third party would both leak your trace ids and trip
CORS preflight (`traceparent` is not a CORS-safelisted header, so the other end
must allow it). Opt an API in explicitly:

```html
<script src="/opa-rum.js"
  data-trace-propagation-targets="https://api.example.com,https://cdn.example.com"></script>
```

## Single-page apps

`history.pushState`, `history.replaceState` and `popstate` are treated as page
views: the beacon flushes what belongs to the outgoing route, then starts a
fresh page view — new `page_view_id`, cleared AJAX and error buffers, the
**same** `session_id`. A same-URL re-push is ignored. So an SPA reports per
route instead of once per tab, and the Sessions view shows the real navigation
path. (A history navigation produces no Navigation Timing entry, so those
page views carry no `navigation_timing`.)

Every payload includes `sdk_version` for server-side compatibility checks.

## Delivery

There is **no build step**: the beacon ships as a single ready-to-serve file,
[`dist/opa-rum.js`](dist/opa-rum.js). Copy it (or serve it straight from this
repo) next to your pages and reference it with a `<script>` tag as shown above.

At runtime the beacon batches everything and POSTs JSON to
`<endpoint>/api/rum` via `navigator.sendBeacon()` when the page is hidden
(`visibilitychange` → hidden, `pagehide`), plus a one-time safety flush ~4 s
after load — so short-lived tabs still report and the final payload carries
settled vitals. `fetch(keepalive)` is the fallback. Call
`window.OpaRum.flush()` manually (e.g. on SPA route changes).

## Demo

Open [`examples/demo.html`](examples/demo.html) next to a **running OPA
dashboard/agent** — the page needs either a same-origin `/api/rum` endpoint
(serve the demo from the dashboard's origin) or a `data-endpoint` attribute
pointing at the agent's origin. The demo generates vitals, resources, AJAX
(including a deliberate 404), and JS errors, with buttons to throw an error
and flush on demand.

## License

MIT © TheGrimmChester

## Wave 12 (v0.3) API

```js
OpaRum.setUser({ id: 'u1', email: 'a@b.co' });
OpaRum.addAction('checkout', { step: 2 });
OpaRum.addTiming('hero_paint', 312);
OpaRum.setAttribute('plan', 'pro');
OpaRum.setConsent('granted'); // or 'denied'
OpaRum.notifyRouteChange();   // framework routers without History API
```

Optional session replay: `data-replay="true"` or `{ replay: true }` posts masked mutation/input chunks to `/api/rum/replay`.

