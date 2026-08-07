/*!
 * OPA RUM — Real User Monitoring beacon for the OpenProfilingAgent.
 *
 * Self-contained, dependency-free (vanilla ES2017, IIFE). Drop this on any page:
 *
 *   <script src="/opa-rum.js"
 *           data-endpoint="http://localhost:8088"
 *           data-organization-id="org_public_123"
 *           data-project-id="proj_public_456"
 *           data-sample-rate="1"
 *           data-debug="false"></script>
 *
 * or configure via a global before the tag loads:
 *
 *   <script>window.OPA_RUM_CONFIG = { endpoint: "...", organizationId: "...",
 *                                     projectId: "...", sampleRate: 1, debug: false };</script>
 *
 * It captures Core Web Vitals (LCP/CLS/INP/FCP/FID/TTFB), navigation + resource
 * timing, AJAX (fetch + XHR), and JS errors, then ships them to
 * <endpoint>/api/rum via navigator.sendBeacon (fetch keepalive fallback).
 *
 * v0.2 additions:
 *   - Trace correlation + SPA page views.
 * v0.3 (Wave 12):
 *   - Route normalization, setUser/addAction/addTiming, device+connection,
 *     element-level CWV, long tasks, bfcache lifecycle, consent mode,
 *     optional session-replay mutation chunks, framework hooks.
 *
 * The JSON payload matches the OPA ingest contract exactly — see main.go
 * (mux.HandleFunc("/api/rum", ...)) and the RUM dashboard.
 */
(function () {
    'use strict';

    var SDK_VERSION = '0.3.0';

    // ---------------------------------------------------------------------
    // Configuration resolution.
    // Priority per field: window.OPA_RUM_CONFIG[field]  >  <script data-*>  >  default.
    // ---------------------------------------------------------------------

    // Locate the <script> element that loaded this file so we can read its
    // data-* attributes. document.currentScript is the reliable path; fall back
    // to the last <script> on the page (or one carrying data-endpoint) for
    // browsers/timing where currentScript is unavailable (e.g. async injection).
    function getScriptEl() {
        if (document.currentScript) return document.currentScript;
        var byAttr = document.querySelector('script[data-endpoint], script[data-organization-id], script[data-project-id]');
        if (byAttr) return byAttr;
        var scripts = document.getElementsByTagName('script');
        return scripts.length ? scripts[scripts.length - 1] : null;
    }

    var scriptEl = getScriptEl();
    var globalCfg = (typeof window.OPA_RUM_CONFIG === 'object' && window.OPA_RUM_CONFIG) ? window.OPA_RUM_CONFIG : {};

    // Read a data-* attribute from the script tag, tolerating a missing element.
    function attr(name) {
        try { return scriptEl ? scriptEl.getAttribute(name) : null; } catch (e) { return null; }
    }

    // First defined (non-null/non-undefined) value wins.
    function pick() {
        for (var i = 0; i < arguments.length; i++) {
            var v = arguments[i];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return undefined;
    }

    // Normalise the endpoint: strip a trailing slash so we can append '/api/rum'
    // without producing a double slash. Default to the current origin.
    function normEndpoint(raw) {
        var base = raw || window.location.origin;
        try { base = String(base).replace(/\/+$/, ''); } catch (e) { base = window.location.origin; }
        return base;
    }

    var rawSampleRate = pick(globalCfg.sampleRate, attr('data-sample-rate'), 1);
    var sampleRate = parseFloat(rawSampleRate);
    if (!isFinite(sampleRate) || sampleRate < 0) sampleRate = 1;
    if (sampleRate > 1) sampleRate = 1;

    var rawDebug = pick(globalCfg.debug, attr('data-debug'), false);
    var DEBUG = rawDebug === true || rawDebug === 'true' || rawDebug === '1';

    // Trace propagation targets: URL/origin prefixes (in addition to the page's
    // own origin) whose requests may carry a `traceparent` header. Accepts an
    // array (global config) or a comma-separated string (data attribute).
    function parseTraceTargets(raw) {
        if (raw == null || raw === '') return [];
        var list = Array.isArray(raw) ? raw : String(raw).split(',');
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var t = String(list[i]).trim();
            if (t) out.push(t);
        }
        return out;
    }

    var CONFIG = {
        endpoint: normEndpoint(pick(globalCfg.endpoint, attr('data-endpoint'))),
        organizationId: pick(globalCfg.organizationId, attr('data-organization-id'), '') || '',
        projectId: pick(globalCfg.projectId, attr('data-project-id'), '') || '',
        ingestKey: pick(globalCfg.ingestKey, attr('data-ingest-key'), '') || '',
        sampleRate: sampleRate,
        debug: DEBUG,
        tracePropagationTargets: parseTraceTargets(pick(globalCfg.tracePropagationTargets, attr('data-trace-propagation-targets'))),
        release: pick(globalCfg.release, attr('data-release'), '') || '',
        environment: pick(globalCfg.environment, attr('data-environment'), '') || '',
        replay: (pick(globalCfg.replay, attr('data-replay'), false) === true ||
                 pick(globalCfg.replay, attr('data-replay'), false) === 'true' ||
                 pick(globalCfg.replay, attr('data-replay'), false) === '1'),
        consent: pick(globalCfg.consent, attr('data-consent'), 'granted') || 'granted'
    };

    var INGEST_URL = CONFIG.endpoint + '/api/rum';
    if (CONFIG.ingestKey) {
        INGEST_URL += (INGEST_URL.indexOf('?') >= 0 ? '&' : '?') + 'ingest_key=' + encodeURIComponent(CONFIG.ingestKey);
    }

    // Quiet by default; only chatter when debug is on.
    function log() {
        if (!CONFIG.debug) return;
        try { console.log.apply(console, ['[opa-rum]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // Sampling gate — bail out entirely (and cheaply) for unsampled loads.
    // ---------------------------------------------------------------------
    var CONSENT = String(CONFIG.consent || 'granted');
    if (Math.random() > CONFIG.sampleRate) {
        log('not sampled (sampleRate=' + CONFIG.sampleRate + '), skipping');
        window.OpaRum = {
            flush: function () {},
            setUser: function () {},
            addAction: function () {},
            addTiming: function () {},
            setAttribute: function () {},
            setConsent: function (c) { CONSENT = String(c || 'denied'); },
            getConsent: function () { return CONSENT; }
        };
        return;
    }

    // ---------------------------------------------------------------------
    // Identity: a session id (persisted for the tab session) and a fresh
    // page-view id per load.
    // ---------------------------------------------------------------------
    function randomId() {
        try {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                return window.crypto.randomUUID();
            }
        } catch (e) {}
        // Fallback: RFC-4122-ish v4 string built from Math.random(). Good enough
        // as an opaque correlation id when crypto.randomUUID is unavailable.
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    function getSessionId() {
        var KEY = 'opa_rum_sid';
        try {
            var existing = window.sessionStorage.getItem(KEY);
            if (existing) return existing;
            var fresh = randomId();
            window.sessionStorage.setItem(KEY, fresh);
            return fresh;
        } catch (e) {
            // sessionStorage can throw (private mode, disabled storage): degrade
            // to a per-load id rather than failing.
            return randomId();
        }
    }

    var SESSION_ID = getSessionId();
    var PAGE_VIEW_ID = randomId();

    // ---------------------------------------------------------------------
    // Trace correlation (W3C Trace Context). Requests to the page's own
    // origin — or to any configured tracePropagationTargets prefix — carry a
    // `traceparent: 00-<trace-id>-<span-id>-01` header, so backend spans can
    // be joined to the RUM ajax entry via its recorded trace_id.
    // ---------------------------------------------------------------------
    function randomHex(bytes) {
        var i;
        try {
            if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
                var buf = new Uint8Array(bytes);
                window.crypto.getRandomValues(buf);
                var hex = '';
                for (i = 0; i < buf.length; i++) {
                    hex += (buf[i] + 0x100).toString(16).slice(1);
                }
                return hex;
            }
        } catch (e) {}
        // Math.random fallback — opaque correlation ids, same spirit as randomId().
        var out = '';
        for (i = 0; i < bytes * 2; i++) {
            out += ((Math.random() * 16) | 0).toString(16);
        }
        return out;
    }

    // Fresh per-call trace context: 16-byte trace id, 8-byte span id.
    function makeTraceContext() {
        return { traceId: randomHex(16), spanId: randomHex(8) };
    }

    function traceparentValue(ctx) {
        return '00-' + ctx.traceId + '-' + ctx.spanId + '-01';
    }

    // Should a request to `url` carry a traceparent header? True for
    // same-origin URLs and for URLs matching a configured target prefix.
    // Cross-origin URLs matching nothing get no header (avoids CORS breakage
    // and leaking ids to third parties).
    function shouldPropagateTrace(url) {
        try {
            var raw = String(url == null ? '' : url);
            var abs = raw;
            var sameOrigin = false;
            var Ctor = (typeof URL === 'function') ? URL : window.URL;
            if (typeof Ctor === 'function') {
                var u = new Ctor(raw, window.location.href);
                abs = u.href;
                sameOrigin = (u.origin === window.location.origin);
            } else {
                // No URL constructor: scheme-less, non-protocol-relative URLs
                // are same-origin by definition.
                sameOrigin = !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(raw);
            }
            if (sameOrigin) return true;
            var targets = CONFIG.tracePropagationTargets;
            for (var i = 0; i < targets.length; i++) {
                if (abs.indexOf(targets[i]) === 0 || raw.indexOf(targets[i]) === 0) return true;
            }
        } catch (e) {}
        return false;
    }

    // Return a fetch `init` whose headers carry the traceparent header while
    // preserving whatever headers were already there — as a Headers instance,
    // an array of pairs, a plain object, or on a Request input. (Passing
    // init.headers alongside a Request replaces the Request's headers
    // wholesale, so those must be copied across, not dropped.)
    function withTraceparent(input, init, value) {
        var newInit = {};
        var k;
        if (init) {
            for (k in init) {
                if (Object.prototype.hasOwnProperty.call(init, k)) newInit[k] = init[k];
            }
        }

        var HeadersCtor = null;
        try { HeadersCtor = (typeof Headers === 'function') ? Headers : window.Headers; } catch (e) {}

        var base = null;
        if (init && init.headers != null) {
            base = init.headers;
        } else if (input && typeof input === 'object' && input.headers &&
                   typeof input.headers.forEach === 'function') {
            base = input.headers; // Request instance
        }

        if (Array.isArray(base)) {
            var arr = base.slice();
            arr.push(['traceparent', value]);
            newInit.headers = arr;
        } else if (base && typeof base.forEach === 'function' && typeof base.set === 'function') {
            // Headers(-like) instance — clone before touching the caller's object.
            var h = (typeof HeadersCtor === 'function') ? new HeadersCtor(base) : base;
            h.set('traceparent', value);
            newInit.headers = h;
        } else if (base && typeof base === 'object') {
            var obj = {};
            for (k in base) {
                if (Object.prototype.hasOwnProperty.call(base, k)) obj[k] = base[k];
            }
            obj.traceparent = value;
            newInit.headers = obj;
        } else {
            newInit.headers = { traceparent: value };
        }
        return newInit;
    }

    // The URL the current page view is attributed to. Captured up front (and on
    // every SPA route change) rather than read at flush time, so a route change
    // never re-labels data that belongs to the previous view.
    var PAGE_URL = window.location.href;

    // SPA (history API) views have no Navigation Timing entry of their own, so
    // navigation_timing is sent empty for them.
    var IS_SPA_VIEW = false;

    // ---------------------------------------------------------------------
    // Buffers (capped so a long-lived page can't grow the payload unbounded).
    // ---------------------------------------------------------------------
    var MAX_RESOURCES = 100;
    var MAX_AJAX = 100;
    var MAX_ERRORS = 50;

    var ajaxRequests = [];
    var errors = [];
    var customEvents = [];
    var customTimings = {};
    var customAttributes = {};
    var userContext = null;
    var longTasks = [];
    var vitalElements = { lcp: null, cls: [], inp: null };
    var lifecycle = { bfcache: false, prerender: false, navigation_type: '' };
    var replayChunks = [];
    var replayBuf = [];
    var MAX_CUSTOM_EVENTS = 50;
    var MAX_LONG_TASKS = 50;
    var MAX_REPLAY_EVENTS = 200;

    // "dirty" tracks whether new data has accrued since the last successful
    // flush. First flush always fires; later flushes only fire if something
    // changed — this satisfies "flush once per dirty state, re-flush on new data".
    var dirty = true;
    function markDirty() { dirty = true; }

    function pushCapped(arr, item, cap) {
        if (arr.length < cap) arr.push(item);
    }

    // ---------------------------------------------------------------------
    // Core Web Vitals via PerformanceObserver. Every observer is wrapped in
    // try/catch because older browsers lack individual entry types.
    // ---------------------------------------------------------------------
    var vitals = { lcp: null, cls: 0, inp: null, fcp: null, fid: null, ttfb: null };
    var clsMeasured = false; // CLS legitimately reports 0; track whether we observed it at all.

    function observe(type, cb, extra) {
        try {
            var opts = { type: type, buffered: true };
            if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) opts[k] = extra[k]; } }
            var po = new PerformanceObserver(cb);
            po.observe(opts);
            return po;
        } catch (e) {
            return null;
        }
    }

    function initWebVitals() {
        // TTFB from the navigation entry's responseStart.
        try {
            var navEntry = performance.getEntriesByType('navigation')[0];
            if (navEntry && isFinite(navEntry.responseStart)) {
                vitals.ttfb = Math.round(navEntry.responseStart);
            }
        } catch (e) {}

        if (typeof PerformanceObserver === 'undefined') return;

        // LCP: keep the latest entry's start time + element selector.
        observe('largest-contentful-paint', function (list) {
            var entries = list.getEntries();
            var last = entries[entries.length - 1];
            if (last) {
                vitals.lcp = Math.round(last.renderTime || last.loadTime || last.startTime);
                try {
                    vitalElements.lcp = {
                        value: vitals.lcp,
                        element: cssPath(last.element),
                        url: last.url || '',
                        size: last.size || 0
                    };
                } catch (e) {}
                markDirty();
            }
        });

        // CLS: sum values for shifts without recent user input; keep top sources.
        observe('layout-shift', function (list) {
            clsMeasured = true;
            list.getEntries().forEach(function (e) {
                if (!e.hadRecentInput) {
                    vitals.cls += e.value;
                    try {
                        var sources = e.sources || [];
                        for (var i = 0; i < sources.length && vitalElements.cls.length < 10; i++) {
                            var node = sources[i] && sources[i].node;
                            if (node) vitalElements.cls.push({ value: e.value, element: cssPath(node) });
                        }
                    } catch (err) {}
                    markDirty();
                }
            });
        });

        // FCP: from the 'paint' entries.
        observe('paint', function (list) {
            list.getEntries().forEach(function (e) {
                if (e.name === 'first-contentful-paint') { vitals.fcp = Math.round(e.startTime); markDirty(); }
            });
        });

        // FID: processingStart - startTime of the first input.
        observe('first-input', function (list) {
            var e = list.getEntries()[0];
            if (e && vitals.fid == null) { vitals.fid = Math.round(e.processingStart - e.startTime); markDirty(); }
        });

        // INP (approximation): the largest event duration seen. durationThreshold
        // keeps the observer from firing on trivially fast interactions.
        observe('event', function (list) {
            list.getEntries().forEach(function (e) {
                if (e.duration && (vitals.inp == null || e.duration > vitals.inp)) {
                    vitals.inp = Math.round(e.duration);
                    try {
                        vitalElements.inp = {
                            value: vitals.inp,
                            element: cssPath(e.target),
                            name: e.name || '',
                            interactionId: e.interactionId || 0
                        };
                    } catch (err) {}
                    markDirty();
                }
            });
        }, { durationThreshold: 40 });
    }

    // Best-effort CSS path for element-level CWV attribution.
    function cssPath(el) {
        try {
            if (!el || !el.tagName) return '';
            var parts = [];
            var cur = el;
            for (var depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
                var part = cur.tagName.toLowerCase();
                if (cur.id) { parts.unshift(part + '#' + cur.id); break; }
                if (cur.className && typeof cur.className === 'string') {
                    var cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
                    if (cls) part += '.' + cls;
                }
                parts.unshift(part);
                cur = cur.parentElement;
            }
            return parts.join(' > ');
        } catch (e) { return ''; }
    }

    function initLongTasks() {
        if (typeof PerformanceObserver === 'undefined') return;
        observe('longtask', function (list) {
            list.getEntries().forEach(function (e) {
                pushCapped(longTasks, {
                    type: 'longtask',
                    start: Math.round(e.startTime),
                    duration: Math.round(e.duration),
                    name: e.name || ''
                }, MAX_LONG_TASKS);
                markDirty();
            });
        });
        // LoAF (long-animation-frame) when available.
        observe('long-animation-frame', function (list) {
            list.getEntries().forEach(function (e) {
                pushCapped(longTasks, {
                    type: 'loaf',
                    start: Math.round(e.startTime),
                    duration: Math.round(e.duration),
                    blocking: Math.round(e.blockingDuration || 0),
                    scripts: (e.scripts && e.scripts.length) || 0
                }, MAX_LONG_TASKS);
                markDirty();
            });
        });
    }

    function initLifecycle() {
        try {
            var nav = performance.getEntriesByType('navigation')[0];
            if (nav) {
                lifecycle.navigation_type = nav.type || '';
                if (nav.activationStart > 0) lifecycle.prerender = true;
            }
        } catch (e) {}
        try {
            if (document.prerendering) lifecycle.prerender = true;
        } catch (e) {}
        window.addEventListener('pageshow', function (ev) {
            try {
                if (ev.persisted) {
                    lifecycle.bfcache = true;
                    markDirty();
                    log('restored from bfcache');
                }
            } catch (e) {}
        });
    }

    function snapshotConnection() {
        var out = {};
        try {
            var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (c) {
                if (c.effectiveType) out.effective_type = c.effectiveType;
                if (c.downlink != null) out.downlink = c.downlink;
                if (c.rtt != null) out.rtt = c.rtt;
                if (c.saveData != null) out.save_data = !!c.saveData;
            }
        } catch (e) {}
        return out;
    }

    function normalizeRoute(href) {
        try {
            var path = href;
            if (typeof URL === 'function') path = new URL(href, window.location.href).pathname;
            else {
                var q = path.indexOf('?');
                if (q >= 0) path = path.slice(0, q);
                var h = path.indexOf('#');
                if (h >= 0) path = path.slice(0, h);
                try {
                    var a = document.createElement('a');
                    a.href = href;
                    path = a.pathname || path;
                } catch (e) {}
            }
            path = path.replace(/\/\d+/g, '/:id');
            path = path.replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '/:uuid');
            path = path.replace(/\/[0-9a-fA-F]{16,}/g, '/:hash');
            return path || '/';
        } catch (e) { return '/'; }
    }

    // Lightweight session replay: MutationObserver + input/click events, always masked.
    var replayChunkIndex = 0;
    function maskText(s) {
        try { return String(s == null ? '' : s).replace(/[\S]/g, '*'); } catch (e) { return '****'; }
    }
    function pushReplay(ev) {
        if (!CONFIG.replay || CONSENT !== 'granted') return;
        pushCapped(replayBuf, ev, MAX_REPLAY_EVENTS);
        if (replayBuf.length >= MAX_REPLAY_EVENTS) flushReplay();
    }
    function flushReplay() {
        if (!CONFIG.replay || !replayBuf.length || CONSENT !== 'granted') return;
        var events = replayBuf.splice(0, replayBuf.length);
        var body = {
            organization_id: CONFIG.organizationId,
            project_id: CONFIG.projectId,
            session_id: SESSION_ID,
            page_view_id: PAGE_VIEW_ID,
            chunk_index: replayChunkIndex++,
            events: events,
            masked: true
        };
        var json;
        try { json = JSON.stringify(body); } catch (e) { return; }
        var url = CONFIG.endpoint + '/api/rum/replay';
        try {
            if (navigator && typeof navigator.sendBeacon === 'function') {
                navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }));
                return;
            }
        } catch (e) {}
        try {
            fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: json }).catch(function () {});
        } catch (e) {}
    }
    function initReplay() {
        if (!CONFIG.replay) return;
        try {
            pushReplay({ t: Date.now(), type: 'snapshot', url: PAGE_URL, title: maskText(document.title || '') });
            var mo = new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    pushReplay({
                        t: Date.now(),
                        type: 'mutation',
                        mutation: m.type,
                        target: cssPath(m.target),
                        added: m.addedNodes ? m.addedNodes.length : 0,
                        removed: m.removedNodes ? m.removedNodes.length : 0
                    });
                }
            });
            mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: false });
            document.addEventListener('click', function (e) {
                pushReplay({ t: Date.now(), type: 'click', target: cssPath(e.target) });
            }, true);
            document.addEventListener('input', function (e) {
                var el = e.target;
                pushReplay({
                    t: Date.now(),
                    type: 'input',
                    target: cssPath(el),
                    value: maskText(el && el.value)
                });
            }, true);
            setInterval(flushReplay, 5000);
        } catch (e) { log('replay init failed', e); }
    }

    // Build the web_vitals object with only measured metrics present.
    function snapshotVitals() {
        var out = {};
        if (vitals.lcp != null) out.lcp = vitals.lcp;
        if (clsMeasured) out.cls = Math.round(vitals.cls * 1000) / 1000;
        if (vitals.inp != null) out.inp = vitals.inp;
        if (vitals.fcp != null) out.fcp = vitals.fcp;
        if (vitals.ttfb != null) out.ttfb = vitals.ttfb;
        if (vitals.fid != null) out.fid = vitals.fid;
        return out;
    }

    // ---------------------------------------------------------------------
    // Navigation timing (from the Navigation Timing Level 2 entry).
    // ---------------------------------------------------------------------
    // Round a value to a non-negative int, or return 0 for NaN/negative.
    function posInt(v) {
        if (typeof v !== 'number' || !isFinite(v) || v < 0) return 0;
        return Math.round(v);
    }

    function snapshotNavigation() {
        var nav;
        try { nav = performance.getEntriesByType('navigation')[0]; } catch (e) { nav = null; }
        if (!nav) return {};
        var start = nav.startTime || 0;
        // loadEventEnd is 0 until the load event fires; fall back to duration.
        var total = nav.loadEventEnd ? nav.loadEventEnd - start : nav.duration;
        return {
            total: posInt(total),
            dom: posInt(nav.domContentLoadedEventEnd - start),
            ttfb: posInt(nav.responseStart - start)
        };
    }

    // ---------------------------------------------------------------------
    // Resource timing (collected fresh at flush time, capped).
    // ---------------------------------------------------------------------
    function snapshotResources() {
        var out = [];
        try {
            var entries = performance.getEntriesByType('resource');
            for (var i = 0; i < entries.length && out.length < MAX_RESOURCES; i++) {
                var e = entries[i];
                out.push({
                    name: e.name,
                    type: e.initiatorType,
                    duration: Math.round(e.duration),
                    size: e.transferSize || 0
                });
            }
        } catch (e) {}
        return out;
    }

    // ---------------------------------------------------------------------
    // AJAX instrumentation: fetch + XMLHttpRequest. Every hook wraps the
    // original, swallows its own errors, and always calls through so it can
    // never break the page's own network code.
    // ---------------------------------------------------------------------
    function instrumentFetch() {
        if (typeof window.fetch !== 'function') return;
        var originalFetch = window.fetch;

        window.fetch = function (input, init) {
            var startedAt = now();
            var url = '';
            var method = 'GET';
            try {
                if (typeof input === 'string') {
                    url = input;
                } else if (input && typeof input.url === 'string') { // Request object
                    url = input.url;
                    if (input.method) method = input.method;
                } else if (input != null) {
                    url = String(input); // URL instance
                }
                if (init && init.method) method = init.method;
            } catch (e) {}

            // Trace correlation: eligible calls get a fresh trace context and
            // a traceparent request header; the ajax entry records the trace id.
            var traceId = null;
            try {
                if (shouldPropagateTrace(url)) {
                    var tctx = makeTraceContext();
                    init = withTraceparent(input, init, traceparentValue(tctx));
                    traceId = tctx.traceId;
                }
            } catch (e) { traceId = null; }

            var record = function (status) {
                try {
                    var entry = {
                        url: url,
                        method: method,
                        duration: Math.round(now() - startedAt),
                        status: status
                    };
                    if (traceId) entry.trace_id = traceId;
                    pushCapped(ajaxRequests, entry, MAX_AJAX);
                    markDirty();
                } catch (e) {}
            };

            var p;
            try {
                p = originalFetch.call(this, input, init);
            } catch (e) {
                record(0);
                throw e;
            }
            return p.then(function (response) {
                record(response ? response.status : 0);
                return response;
            }, function (err) {
                record(0); // network failure / abort
                throw err;
            });
        };
    }

    function instrumentXHR() {
        if (typeof window.XMLHttpRequest !== 'function') return;
        var proto = window.XMLHttpRequest.prototype;
        var originalOpen = proto.open;
        var originalSend = proto.send;

        proto.open = function (method, url) {
            try {
                this.__opaMethod = method || 'GET';
                this.__opaUrl = url || '';
            } catch (e) {}
            return originalOpen.apply(this, arguments);
        };

        proto.send = function () {
            var xhr = this;
            try {
                var startedAt = now();

                // Trace correlation: request headers may only be set between
                // open() and send(), which is exactly where this wrapper runs.
                var traceId = null;
                try {
                    if (shouldPropagateTrace(xhr.__opaUrl || '')) {
                        var tctx = makeTraceContext();
                        xhr.setRequestHeader('traceparent', traceparentValue(tctx));
                        traceId = tctx.traceId;
                    }
                } catch (e) { traceId = null; }

                xhr.addEventListener('loadend', function () {
                    try {
                        var entry = {
                            url: xhr.__opaUrl || '',
                            method: xhr.__opaMethod || 'GET',
                            duration: Math.round(now() - startedAt),
                            status: xhr.status || 0
                        };
                        if (traceId) entry.trace_id = traceId;
                        pushCapped(ajaxRequests, entry, MAX_AJAX);
                        markDirty();
                    } catch (e) {}
                });
            } catch (e) {}
            return originalSend.apply(this, arguments);
        };
    }

    // ---------------------------------------------------------------------
    // JS error capture.
    // ---------------------------------------------------------------------
    function instrumentErrors() {
        window.addEventListener('error', function (event) {
            try {
                pushCapped(errors, {
                    message: event.message || (event.error && event.error.message) || 'Error',
                    source: event.filename || '',
                    line: event.lineno || 0,
                    col: event.colno || 0,
                    stack: (event.error && event.error.stack) ? String(event.error.stack) : ''
                }, MAX_ERRORS);
                markDirty();
            } catch (e) {}
        });

        window.addEventListener('unhandledrejection', function (event) {
            try {
                var reason = event.reason;
                var message = 'Unhandled promise rejection';
                var stack = '';
                if (reason) {
                    message = (reason.message != null) ? String(reason.message) : String(reason);
                    if (reason.stack) stack = String(reason.stack);
                }
                pushCapped(errors, {
                    message: message,
                    source: '',
                    line: 0,
                    col: 0,
                    stack: stack
                }, MAX_ERRORS);
                markDirty();
            } catch (e) {}
        });
    }

    // High-resolution clock with a wall-clock fallback.
    function now() {
        try { return performance.now(); } catch (e) { return Date.now(); }
    }

    // ---------------------------------------------------------------------
    // SPA page views: every history route change closes out the current page
    // view (flush) and starts a fresh one — new page_view_id, fresh ajax and
    // error buffers (the session id is kept), and no navigation_timing, since
    // a history navigation produces no Navigation Timing entry.
    // ---------------------------------------------------------------------
    function onRouteChange() {
        try {
            var href = window.location.href;
            if (href === PAGE_URL) return; // same-URL no-op (re-pushed state)

            // Ship what belongs to the outgoing view first; buildPayload()
            // attributes it to PAGE_URL, which still holds the old location.
            flush();

            PAGE_VIEW_ID = randomId();
            PAGE_URL = href;
            IS_SPA_VIEW = true;
            ajaxRequests.length = 0;
            errors.length = 0;
            longTasks.length = 0;
            vitalElements = { lcp: null, cls: [], inp: null };
            customEvents.length = 0;
            dirty = true; // the new view is itself reportable data
            pushReplay({ t: Date.now(), type: 'navigate', url: PAGE_URL });
            log('spa route change', { pageView: PAGE_VIEW_ID, url: PAGE_URL });
        } catch (e) {}
    }

    function instrumentHistory() {
        try {
            var h = window.history;
            if (!h) return;
            ['pushState', 'replaceState'].forEach(function (name) {
                var original = h[name];
                if (typeof original !== 'function') return;
                h[name] = function () {
                    var result = original.apply(this, arguments);
                    onRouteChange();
                    return result;
                };
            });
            window.addEventListener('popstate', onRouteChange);
        } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // Flush: assemble the payload (matching the ingest contract EXACTLY) and
    // ship it. sendBeacon can't set headers, so org/project ids live only in
    // the JSON body.
    // ---------------------------------------------------------------------
    function buildPayload() {
        var payload = {
            sdk_version: SDK_VERSION,
            organization_id: CONFIG.organizationId,
            project_id: CONFIG.projectId,
            ingest_key: CONFIG.ingestKey || undefined,
            session_id: SESSION_ID,
            page_view_id: PAGE_VIEW_ID,
            page_url: PAGE_URL,
            route: normalizeRoute(PAGE_URL),
            user_agent: navigator.userAgent,
            timestamp: Date.now(),
            release: CONFIG.release,
            environment: CONFIG.environment,
            consent: CONSENT,
            // SPA views have no Navigation Timing entry of their own.
            navigation_timing: IS_SPA_VIEW ? {} : snapshotNavigation(),
            web_vitals: snapshotVitals(),
            web_vitals_elements: {
                lcp: vitalElements.lcp,
                cls: vitalElements.cls.slice(0, 10),
                inp: vitalElements.inp
            },
            long_tasks: longTasks.slice(0, MAX_LONG_TASKS),
            lifecycle: {
                bfcache: !!lifecycle.bfcache,
                prerender: !!lifecycle.prerender,
                navigation_type: lifecycle.navigation_type || ''
            },
            connection: snapshotConnection(),
            attributes: customAttributes,
            custom_events: customEvents.slice(0, MAX_CUSTOM_EVENTS),
            custom_timings: customTimings,
            resource_timing: snapshotResources(),
            ajax_requests: ajaxRequests.slice(0, MAX_AJAX),
            errors: errors.slice(0, MAX_ERRORS),
            viewport: {
                width: window.innerWidth || document.documentElement.clientWidth || 0,
                height: window.innerHeight || document.documentElement.clientHeight || 0
            }
        };
        if (userContext) {
            payload.user = userContext;
            if (userContext.id != null) payload.user_id = String(userContext.id);
        }
        return payload;
    }

    function flush() {
        // Only send if new data has accrued since the last flush.
        if (!dirty) { log('flush skipped (not dirty)'); return; }
        if (CONSENT === 'denied') { log('flush skipped (consent denied)'); dirty = false; return; }

        var payload = buildPayload();
        var json;
        try { json = JSON.stringify(payload); } catch (e) { return; }

        var sent = false;
        try {
            if (navigator && typeof navigator.sendBeacon === 'function') {
                var blob = new Blob([json], { type: 'application/json' });
                sent = navigator.sendBeacon(INGEST_URL, blob);
            }
        } catch (e) {
            sent = false;
        }

        if (!sent) {
            // Fallback for browsers without sendBeacon (or when it refuses the
            // payload). keepalive lets the request survive page unload.
            try {
                fetch(INGEST_URL, {
                    method: 'POST',
                    keepalive: true,
                    headers: { 'Content-Type': 'application/json' },
                    body: json
                }).catch(function () { /* never break the page */ });
                sent = true;
            } catch (e) {
                sent = false;
            }
        }

        if (sent) {
            dirty = false;
            flushReplay();
            log('flushed', payload);
        }
    }

    // ---------------------------------------------------------------------
    // Wire everything up.
    // ---------------------------------------------------------------------
    initWebVitals();
    initLongTasks();
    initLifecycle();
    instrumentFetch();
    instrumentXHR();
    instrumentErrors();
    instrumentHistory();
    initReplay();

    // Flush when the tab is backgrounded/closed — the most reliable moment to
    // capture settled vitals without racing the unload.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', function () { flush(); flushReplay(); });

    // One-time safety flush shortly after load so very short-lived tabs (that
    // never fire visibilitychange/pagehide) still report at least once.
    function scheduleSafetyFlush() {
        setTimeout(flush, 4000);
    }
    if (document.readyState === 'complete') {
        scheduleSafetyFlush();
    } else {
        window.addEventListener('load', scheduleSafetyFlush);
    }

    window.OpaRum = {
        flush: flush,
        setUser: function (u) {
            userContext = (u && typeof u === 'object') ? u : null;
            markDirty();
        },
        addAction: function (name, attrs) {
            pushCapped(customEvents, {
                name: String(name || ''),
                attributes: (attrs && typeof attrs === 'object') ? attrs : {},
                timestamp: Date.now()
            }, MAX_CUSTOM_EVENTS);
            markDirty();
        },
        addTiming: function (name, ms) {
            if (!name) return;
            customTimings[String(name)] = typeof ms === 'number' ? ms : 0;
            markDirty();
        },
        setAttribute: function (k, v) {
            if (!k) return;
            customAttributes[String(k)] = v;
            markDirty();
        },
        setConsent: function (c) {
            CONSENT = String(c || 'denied');
            markDirty();
        },
        getConsent: function () { return CONSENT; },
        // Framework hooks: call on every SPA route change if History API is not used.
        notifyRouteChange: onRouteChange,
        instrumentReactRouter: function (history) {
            try {
                if (history && typeof history.listen === 'function') {
                    history.listen(function () { onRouteChange(); });
                }
            } catch (e) {}
        },
        instrumentVueRouter: function (router) {
            try {
                if (router && typeof router.afterEach === 'function') {
                    router.afterEach(function () { onRouteChange(); });
                }
            } catch (e) {}
        }
    };

    log('initialized', { endpoint: CONFIG.endpoint, session: SESSION_ID, pageView: PAGE_VIEW_ID, replay: CONFIG.replay });
})();
