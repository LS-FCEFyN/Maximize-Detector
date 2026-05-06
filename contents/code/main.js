// KWIN script to detect when windows are maximized

// This is a standalone script that can be loaded into KWin to detect when windows
// are maximized, and notify the Linux Wallpaper Engine via D-Bus.

// Script created with the sole purpose of adding support for
// Linux Wallpaper Engine pause on maximize / fullscreen feature on KDE Plasma.

// Revision 8

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBUG = false; // Set to true to enable verbose logging

const DBUS_SERVICE = "org.linuxwallpaperengine.WaylandDetector";
const DBUS_PATH    = "/org/linuxwallpaperengine/WaylandDetector";

const MODE_RESTORED   = 0;
const MODE_VERTICAL   = 1;
const MODE_HORIZONTAL = 2;
const MODE_FULL       = 3;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const windowKey = (w) =>
    w.internalId ? String(w.internalId) : `${w.pid}:${w.caption}`;

const windowAppId = (w) => {
    // Prefer Wayland app id / desktop id style properties, then X11 WM_CLASS.
    const raw = w.desktopFileName || w.resourceClass || w.resourceName || "";
    return String(raw);
};

const modeToState = (mode, isFullScreen) => {
    const fully = mode === MODE_FULL || isFullScreen;
    return {
        h: mode === MODE_HORIZONTAL || mode === MODE_FULL || isFullScreen,
        v: mode === MODE_VERTICAL   || mode === MODE_FULL || isFullScreen,
        fully,
    };
};

const currentState = (w) => modeToState(w.maximizeMode, w.fullScreen || false);

// ---------------------------------------------------------------------------
// Window state cache  { key → { h, v, fully } | null }
//
// Replaces the plain connectedWindows Set. Storing the last-notified state
// here lets notify() skip redundant D-Bus calls whenever the state hasn't
// actually changed (e.g. repeated windowActivated events for the same window).
//
// A null value means "connected but no notification sent yet" (startup sentinel).
// ---------------------------------------------------------------------------

const windowCache = new Map();

// ---------------------------------------------------------------------------
// Side-effectful helpers
// ---------------------------------------------------------------------------

/**
 * Send a D-Bus notification — but only if the state has actually changed
 * since the last call for this window. The cache check makes every call site
 * unconditional; deduplication is handled here rather than scattered across
 * the signal handlers.
 */
const notify = (w, h, v, fully) => {
    try {
        const key    = windowKey(w);
        const cached = windowCache.get(key);

        // Skip if nothing changed.
        if (cached && cached.h === h && cached.v === v && cached.fully === fully) return;

        windowCache.set(key, { h, v, fully });

        if (DEBUG) {
            const appId = windowAppId(w);
            console.info(
                "[MaximizeDetector] notify:", w.caption,
                "pid=", w.pid, "appId=", appId,
                "h=", h, "v=", v, "fully=", fully
            );
        }

        callDBus(
            DBUS_SERVICE, DBUS_PATH, DBUS_SERVICE,
            "OnWindowChanged",
            windowKey(w), w.caption, w.pid, windowAppId(w), h, v, fully
        );
    } catch (e) {
        console.warn("[MaximizeDetector] D-Bus call failed:", e);
    }
};

// ---------------------------------------------------------------------------
// Per-window connection factory
// ---------------------------------------------------------------------------

/**
 * Wires up all KWin signals for a single window.
 *
 * All state is local to this closure:
 *
 * pendingMode — race-condition guard. When KWin applies a maximize action,
 * geometry signals fire before `maximizeMode` updates. `maximizedAboutToChange`
 * arms this with the target mode so `evaluateState` reads the correct value
 * while the property is still stale. Clears itself once the property catches up.
 *
 * wasFully — tracks the previous fully-maximized state so `evaluateState` can
 * detect transitions without consulting any external map.
 *
 * No shared state is needed: whenever we need the current maximize state of a
 * window we simply read w.maximizeMode / w.fullScreen directly from KWin.
 */
const connectWindow = (w) => {
    if (w.specialWindow) return;

    const key = windowKey(w);
    if (windowCache.has(key)) return; // already connected — bail early

    // Register with a null sentinel before any signals can fire.
    windowCache.set(key, null);

    if (DEBUG) {
        console.info(
            "[MaximizeDetector] connectWindow:", w.caption,
            "pid=", w.pid, "key=", key,
            "internalId=", w.internalId ? String(w.internalId) : "<none>"
        );
    }

    let pendingMode = null; // see note above
    let wasFully    = false;

    // ------------------------------------------------------------------
    // 1. evaluateState — safe to bind to high-frequency geometry signals
    // ------------------------------------------------------------------

    const evaluateState = () => {
        let mode = w.maximizeMode;
        if (pendingMode !== null) {
            if (mode === pendingMode) pendingMode = null; // property caught up
            else mode = pendingMode;                      // property still stale
        }

        const { h, v, fully } = modeToState(mode, w.fullScreen || false);

        if (DEBUG) {
            console.info(
                "[MaximizeDetector] evaluateState:", w.caption,
                "mode=", mode, "wasFully=", wasFully,
                "active=", workspace.activeWindow === w
            );
        }

        if (fully === wasFully) return;

        if (DEBUG) {
            console.info(
                "[MaximizeDetector] State transition:", w.caption,
                "fully:", wasFully, "→", fully
            );
        }

        wasFully = fully;
        if (workspace.activeWindow === w) {
            notify(w, h, v, fully);
        }
    };

    // Run once immediately to pick up windows already maximized at startup.
    evaluateState();

    // ------------------------------------------------------------------
    // 2. Geometry / fullscreen signals
    //
    // Only frameGeometryChanged is needed — it supersedes the older
    // geometryChanged signal in KWin 6 and connecting both would invoke
    // evaluateState twice per frame during resize/move.
    // ------------------------------------------------------------------

    w.frameGeometryChanged?.connect(evaluateState);
    w.fullScreenChanged?.connect(evaluateState);

    // ------------------------------------------------------------------
    // 3. Explicit maximize / restore
    // ------------------------------------------------------------------

    w.maximizedAboutToChange?.connect((mode) => {
        if (DEBUG) console.info("[MaximizeDetector] maximizedAboutToChange:", w.caption, "mode=", mode);
        pendingMode = mode;
        wasFully = (mode === MODE_FULL);
        const { h, v, fully } = modeToState(mode, w.fullScreen || false);
        if (workspace.activeWindow === w) {
            notify(w, h, v, fully);
        }
    });

    // ------------------------------------------------------------------
    // 4. Minimise / restore
    // KWin preserves maximizeMode while a window is minimised, so we
    // can read it directly rather than recalling it from a cache.
    // ------------------------------------------------------------------

    w.minimizedChanged?.connect(() => {
        const { h, v, fully } = currentState(w);
        if (DEBUG) {
            console.info(
                "[MaximizeDetector] minimizedChanged:", w.caption,
                "minimized=", w.minimized, "fully=", fully
            );
        }
        if (!fully) return; // wasn't maximized — nothing to tell the engine
        w.minimized
            ? notify(w, false, false, false)
            : notify(w, h, v, fully);
    });

    // ------------------------------------------------------------------
    // 5. Cleanup on close
    // Both closure variables vanish with this scope automatically.
    // ------------------------------------------------------------------

    w.closed?.connect(() => {
        if (DEBUG) console.info("[MaximizeDetector] closed:", w.caption, "key=", key);
        if (wasFully) notify(w, false, false, false);
        windowCache.delete(key);
    });
};

// ---------------------------------------------------------------------------
// Focus handler
// ---------------------------------------------------------------------------

const onWindowActivated = (w) => {
    if (!w || w.specialWindow) return;
    if (!windowCache.has(windowKey(w))) return; // not yet connected

    const { h, v, fully } = currentState(w);
    // notify() handles deduplication via windowCache — no extra guard needed.
    notify(w, h, v, fully);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const init = () => {
    if (DEBUG) console.info("[MaximizeDetector] Starting...");
    workspace.windowList().forEach(connectWindow);
    workspace.windowAdded.connect(connectWindow);
    workspace.windowActivated.connect(onWindowActivated);
    if (DEBUG) console.info("[MaximizeDetector] Init complete");
};

init();