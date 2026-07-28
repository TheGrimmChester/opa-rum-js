'use strict';

/**
 * Unit tests for the RUM beacon (dist/opa-rum.js).
 *
 * The beacon is a browser IIFE, so each test builds a fresh DOM with
 * happy-dom, wires the globals the script touches into a new `vm` context
 * (window, document, navigator, performance, ...), stubs the few APIs
 * happy-dom does not provide (PerformanceObserver, sendBeacon,
 * performance.getEntriesByType), and evaluates the file inside that context.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Window } = require('happy-dom');

const BEACON_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'opa-rum.js'),
    'utf8'
);

/**
 * Build a DOM + vm context, evaluate the beacon in it, and return handles.
 *
 * options:
 *   config      — value for window.OPA_RUM_CONFIG (omit to leave unset)
 *   scriptAttrs — data-* attributes for a <script> element that is appended
 *                 to the document and exposed as document.currentScript
 */
function loadBeacon(options = {}) {
    const window = new Window({ url: 'http://localhost:8080/some/page' });
    const document = window.document;

    // --- navigator with a capturing sendBeacon stub. happy-dom's Navigator
    // accessors rely on private class fields, so delegation via Object.create
    // breaks — use a plain object exposing just what the beacon reads.
    const beaconCalls = [];
    const fetchCalls = [];
    const navigator = {
        userAgent: window.navigator.userAgent,
        sendBeacon(url, body) {
            beaconCalls.push({ url, body });
            return true;
        }
    };

    // --- minimal performance stub (all the beacon uses).
    const performance = {
        now: () => Date.now(),
        getEntriesByType: () => []
    };

    // Capturing fetch. The beacon wraps `window.fetch`, so the stub has to live
    // there (happy-dom's own fetch would hit the network); the recorded calls
    // are what the wrapper forwarded — where traceparent injection is visible.
    const fetchStub = (input, init) => {
        fetchCalls.push({ input, init });
        return Promise.resolve({ status: 200 });
    };
    Object.defineProperty(window, 'fetch', {
        configurable: true, writable: true, value: fetchStub
    });

    // --- script element carrying data-* config, when requested.
    let scriptEl = null;
    if (options.scriptAttrs) {
        scriptEl = document.createElement('script');
        for (const [name, value] of Object.entries(options.scriptAttrs)) {
            scriptEl.setAttribute(name, value);
        }
        document.body.appendChild(scriptEl);
        // document.currentScript is what the beacon checks first.
        Object.defineProperty(document, 'currentScript', {
            configurable: true,
            get: () => scriptEl
        });
    }

    if (options.config !== undefined) {
        window.OPA_RUM_CONFIG = options.config;
    }

    // --- fresh realm with the browser globals the IIFE references bare.
    const sandbox = {
        window,
        document,
        navigator,
        performance,
        sessionStorage: window.sessionStorage,
        Blob, // Node's Blob, so tests can await body.text()
        PerformanceObserver: class {
            observe() {}
            disconnect() {}
        },
        console,
        // Swallow the 4s safety flush so nothing keeps the test alive.
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
        // Bare `fetch` references resolve to the same stub the beacon wraps on
        // window (see fetchStub above).
        fetch: fetchStub
    };
    const context = vm.createContext(sandbox);
    // Deterministic sampling: 0.5 > 1 is false (sampled at rate 1),
    // 0.5 > 0 is true (dropped at rate 0).
    vm.runInContext('Math.random = function () { return 0.5; };', context);

    vm.runInContext(BEACON_SOURCE, context, { filename: 'opa-rum.js' });

    return { window, beaconCalls, fetchCalls, close: () => window.close() };
}

// Pull the traceparent value out of whatever header shape the wrapper produced.
function traceparentOf(init) {
    const h = init && init.headers;
    if (!h) return null;
    if (Array.isArray(h)) {
        const hit = h.find((pair) => String(pair[0]).toLowerCase() === 'traceparent');
        return hit ? hit[1] : null;
    }
    if (typeof h.get === 'function') return h.get('traceparent');
    return h.traceparent || h.Traceparent || null;
}

async function readBody(body) {
    if (body && typeof body.text === 'function') return body.text(); // Blob
    return String(body);
}

test('flush() sends the full payload via sendBeacon to <endpoint>/api/rum', async () => {
    const { window, beaconCalls, close } = loadBeacon({
        config: {
            endpoint: 'http://x',
            organizationId: 'o',
            projectId: 'p',
            sampleRate: 1,
            debug: false
        }
    });

    try {
        assert.ok(window.OpaRum, 'OpaRum global should be exported when sampled');
        assert.strictEqual(typeof window.OpaRum.flush, 'function');

        window.OpaRum.flush();

        assert.strictEqual(beaconCalls.length, 1, 'sendBeacon called exactly once');
        assert.strictEqual(beaconCalls[0].url, 'http://x/api/rum');

        const payload = JSON.parse(await readBody(beaconCalls[0].body));
        assert.strictEqual(payload.organization_id, 'o');
        assert.strictEqual(payload.project_id, 'p');
        assert.ok(payload.session_id, 'payload carries a session_id');
        assert.ok(payload.page_view_id, 'payload carries a page_view_id');
        assert.ok(
            payload.navigation_timing && typeof payload.navigation_timing === 'object',
            'payload carries navigation_timing'
        );
        assert.ok(
            payload.viewport && typeof payload.viewport === 'object',
            'payload carries viewport'
        );
        assert.strictEqual(typeof payload.viewport.width, 'number');
        assert.strictEqual(typeof payload.viewport.height, 'number');

        // Not dirty anymore: a second flush with no new data must not re-send.
        window.OpaRum.flush();
        assert.strictEqual(beaconCalls.length, 1, 'clean flush does not re-send');
    } finally {
        close();
    }
});

test('sampleRate 0 drops the load: no OpaRum global, no beacon', () => {
    const { window, beaconCalls, close } = loadBeacon({
        config: {
            endpoint: 'http://x',
            organizationId: 'o',
            projectId: 'p',
            sampleRate: 0,
            debug: false
        }
    });

    try {
        assert.strictEqual(window.OpaRum, undefined, 'unsampled load exports nothing');
        assert.strictEqual(beaconCalls.length, 0, 'unsampled load never beacons');
    } finally {
        close();
    }
});

test('config via <script data-*> attributes (document.currentScript)', async () => {
    const { window, beaconCalls, close } = loadBeacon({
        scriptAttrs: {
            'data-endpoint': 'http://y/', // trailing slash must be normalised away
            'data-organization-id': 'org-from-attr',
            'data-project-id': 'proj-from-attr',
            'data-sample-rate': '1'
        }
    });

    try {
        assert.ok(window.OpaRum, 'OpaRum exported');
        window.OpaRum.flush();

        assert.strictEqual(beaconCalls.length, 1);
        assert.strictEqual(beaconCalls[0].url, 'http://y/api/rum');

        const payload = JSON.parse(await readBody(beaconCalls[0].body));
        assert.strictEqual(payload.organization_id, 'org-from-attr');
        assert.strictEqual(payload.project_id, 'proj-from-attr');
    } finally {
        close();
    }
});

// --- v0.2: RUM ↔ trace correlation -----------------------------------------

test('same-origin AJAX carries a traceparent header and records its trace_id', async () => {
    const { window, beaconCalls, fetchCalls, close } = loadBeacon({
        config: { endpoint: 'http://x', organizationId: 'o', projectId: 'p', sampleRate: 1 }
    });

    try {
        // Page origin is http://localhost:8080 (see loadBeacon).
        await window.fetch('http://localhost:8080/api/orders');

        assert.strictEqual(fetchCalls.length, 1, 'the wrapper called through to the original fetch');
        const tp = traceparentOf(fetchCalls[0].init);
        assert.ok(tp, 'a traceparent header was injected');
        assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, 'traceparent is well-formed W3C');

        window.OpaRum.flush();
        const payload = JSON.parse(await readBody(beaconCalls[0].body));
        assert.strictEqual(payload.ajax_requests.length, 1);
        const entry = payload.ajax_requests[0];
        assert.ok(entry.trace_id, 'the ajax entry records a trace_id');
        assert.strictEqual(
            tp.split('-')[1], entry.trace_id,
            'recorded trace_id matches the trace id sent on the wire'
        );
        assert.strictEqual(payload.sdk_version, '0.2.0');
    } finally {
        close();
    }
});

test('cross-origin AJAX is not traced unless allow-listed', async () => {
    const { window, beaconCalls, fetchCalls, close } = loadBeacon({
        config: { endpoint: 'http://x', organizationId: 'o', projectId: 'p', sampleRate: 1 }
    });

    try {
        await window.fetch('https://third-party.example.com/pixel');

        assert.strictEqual(traceparentOf(fetchCalls[0].init), null, 'no header on a foreign origin');

        window.OpaRum.flush();
        const payload = JSON.parse(await readBody(beaconCalls[0].body));
        assert.strictEqual(payload.ajax_requests[0].trace_id, undefined, 'no trace_id recorded');
    } finally {
        close();
    }
});

test('tracePropagationTargets opts a cross-origin API into tracing', async () => {
    const { window, fetchCalls, close } = loadBeacon({
        config: {
            endpoint: 'http://x', organizationId: 'o', projectId: 'p', sampleRate: 1,
            tracePropagationTargets: ['https://api.example.com']
        }
    });

    try {
        await window.fetch('https://api.example.com/v1/orders');
        assert.match(traceparentOf(fetchCalls[0].init) || '', /^00-[0-9a-f]{32}-/);
    } finally {
        close();
    }
});

test('an SPA route change flushes the old page view and starts a new one', async () => {
    const { window, beaconCalls, close } = loadBeacon({
        config: { endpoint: 'http://x', organizationId: 'o', projectId: 'p', sampleRate: 1 }
    });

    try {
        window.history.pushState({}, '', '/next-route');

        assert.ok(beaconCalls.length >= 1, 'the route change flushed the previous page view');
        const first = JSON.parse(await readBody(beaconCalls[0].body));

        // Make the new page view dirty so it is allowed to flush, then send it.
        await window.fetch('http://localhost:8080/api/after-nav');
        window.OpaRum.flush();

        const second = JSON.parse(await readBody(beaconCalls[beaconCalls.length - 1].body));
        assert.notStrictEqual(
            second.page_view_id, first.page_view_id,
            'the post-navigation payload uses a fresh page_view_id'
        );
        assert.strictEqual(second.session_id, first.session_id, 'the session id is preserved');
        assert.ok(String(second.page_url).endsWith('/next-route'), 'page_url tracks the new route');
    } finally {
        close();
    }
});
