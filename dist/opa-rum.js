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
 * The JSON payload matches the OPA ingest contract exactly — see main.go
 * (mux.HandleFunc("/api/rum", ...)) and the RUM dashboard.
 */
(function () {
    'use strict';

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

    var CONFIG = {
        endpoint: normEndpoint(pick(globalCfg.endpoint, attr('data-endpoint'))),
        organizationId: pick(globalCfg.organizationId, attr('data-organization-id'), '') || '',
        projectId: pick(globalCfg.projectId, attr('data-project-id'), '') || '',
        sampleRate: sampleRate,
        debug: DEBUG
    };

    var INGEST_URL = CONFIG.endpoint + '/api/rum';

    // Quiet by default; only chatter when debug is on.
    function log() {
        if (!CONFIG.debug) return;
        try { console.log.apply(console, ['[opa-rum]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // Sampling gate — bail out entirely (and cheaply) for unsampled loads.
    // ---------------------------------------------------------------------
    if (Math.random() > CONFIG.sampleRate) {
        log('not sampled (sampleRate=' + CONFIG.sampleRate + '), skipping');
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
    // Buffers (capped so a long-lived page can't grow the payload unbounded).
    // ---------------------------------------------------------------------
    var MAX_RESOURCES = 100;
    var MAX_AJAX = 100;
    var MAX_ERRORS = 50;

    var ajaxRequests = [];
    var errors = [];

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

        // LCP: keep the latest entry's start time.
        observe('largest-contentful-paint', function (list) {
            var entries = list.getEntries();
            var last = entries[entries.length - 1];
            if (last) {
                vitals.lcp = Math.round(last.renderTime || last.loadTime || last.startTime);
                markDirty();
            }
        });

        // CLS: sum values for shifts without recent user input.
        observe('layout-shift', function (list) {
            clsMeasured = true;
            list.getEntries().forEach(function (e) {
                if (!e.hadRecentInput) { vitals.cls += e.value; markDirty(); }
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
                    markDirty();
                }
            });
        }, { durationThreshold: 40 });
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

            var record = function (status) {
                try {
                    pushCapped(ajaxRequests, {
                        url: url,
                        method: method,
                        duration: Math.round(now() - startedAt),
                        status: status
                    }, MAX_AJAX);
                    markDirty();
                } catch (e) {}
            };

            var p;
            try {
                p = originalFetch.apply(this, arguments);
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
                xhr.addEventListener('loadend', function () {
                    try {
                        pushCapped(ajaxRequests, {
                            url: xhr.__opaUrl || '',
                            method: xhr.__opaMethod || 'GET',
                            duration: Math.round(now() - startedAt),
                            status: xhr.status || 0
                        }, MAX_AJAX);
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
    // Flush: assemble the payload (matching the ingest contract EXACTLY) and
    // ship it. sendBeacon can't set headers, so org/project ids live only in
    // the JSON body.
    // ---------------------------------------------------------------------
    function buildPayload() {
        return {
            organization_id: CONFIG.organizationId,
            project_id: CONFIG.projectId,
            session_id: SESSION_ID,
            page_view_id: PAGE_VIEW_ID,
            page_url: window.location.href,
            user_agent: navigator.userAgent,
            timestamp: Date.now(),
            navigation_timing: snapshotNavigation(),
            web_vitals: snapshotVitals(),
            resource_timing: snapshotResources(),
            ajax_requests: ajaxRequests.slice(0, MAX_AJAX),
            errors: errors.slice(0, MAX_ERRORS),
            viewport: {
                width: window.innerWidth || document.documentElement.clientWidth || 0,
                height: window.innerHeight || document.documentElement.clientHeight || 0
            }
        };
    }

    function flush() {
        // Only send if new data has accrued since the last flush.
        if (!dirty) { log('flush skipped (not dirty)'); return; }

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
            log('flushed', payload);
        }
    }

    // ---------------------------------------------------------------------
    // Wire everything up.
    // ---------------------------------------------------------------------
    initWebVitals();
    instrumentFetch();
    instrumentXHR();
    instrumentErrors();

    // Flush when the tab is backgrounded/closed — the most reliable moment to
    // capture settled vitals without racing the unload.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);

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

    // Manual flush hook — the only global we export.
    window.OpaRum = { flush: flush };

    log('initialized', { endpoint: CONFIG.endpoint, session: SESSION_ID, pageView: PAGE_VIEW_ID });
})();
