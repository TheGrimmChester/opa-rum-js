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
        fetch: () => Promise.resolve({ status: 200 })
    };
    const context = vm.createContext(sandbox);
    // Deterministic sampling: 0.5 > 1 is false (sampled at rate 1),
    // 0.5 > 0 is true (dropped at rate 0).
    vm.runInContext('Math.random = function () { return 0.5; };', context);

    vm.runInContext(BEACON_SOURCE, context, { filename: 'opa-rum.js' });

    return { window, beaconCalls, close: () => window.close() };
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
