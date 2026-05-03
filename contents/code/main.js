// KWIN script to detect when windows are maximized
// This is a standalone script that can be loaded into KWin to detect when windows
// are maximized, and notify the Linux Wallpaper Engine via D-Bus.
// Script created with the sole purpose of adding support for
// Linux Wallpaper Engine pause on maximize / fullscreen feature on KDE Plasma.

// Revision 7

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
        h:     mode === MODE_HORIZONTAL || mode === MODE_FULL || isFullScreen,
        v:     mode === MODE_VERTICAL   || mode === MODE_FULL || isFullScreen,
        fully,
    };
};

const currentState = (w) => modeToState(w.maximizeMode, w.fullScreen || false);

// ---------------------------------------------------------------------------
// Side-effectful helpers
// ---------------------------------------------------------------------------

const notify = (w, h, v, fully) => {
    try {
        const appId = windowAppId(w);
        console.info(
            "[MaximizeDetector] notify:", w.caption,
            "pid=", w.pid, "appId=", appId,
            "h=", h, "v=", v, "fully=", fully
        );
        callDBus(
            DBUS_SERVICE, DBUS_PATH, DBUS_SERVICE,
            "OnWindowChanged",
            windowKey(w), w.caption, w.pid, appId, h, v, fully
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
 *  pendingMode — race-condition guard. When KWin applies a maximize action,
 *    geometry signals fire before `maximizeMode` updates. `maximizedAboutToChange`
 *    arms this with the target mode so `evaluateState` reads the correct value
 *    while the property is still stale. Clears itself once the property catches up.
 *
 *  wasFully — tracks the previous fully-maximized state so `evaluateState` can
 *    detect transitions without consulting any external map.
 *
 * No shared state is needed: whenever we need the current maximize state of a
 * window we simply read w.maximizeMode / w.fullScreen directly from KWin.
 */
const connectedWindows = new Set();

const connectWindow = (w) => {
    if (w.specialWindow) return;

    const key = windowKey(w);
    connectedWindows.add(key);          // ← mark as connected before anything else

    console.info(
        "[MaximizeDetector] connectWindow:", w.caption,
        "pid=", w.pid, "key=", key,
        "internalId=", w.internalId ? String(w.internalId) : "<none>"
    );

    let pendingMode = null; // see note above
    let wasFully    = false;

    // ------------------------------------------------------------------
    // 1. evaluateState — safe to bind to high-frequency geometry signals
    // ------------------------------------------------------------------
    const evaluateState = () => {
        let mode = w.maximizeMode;

        if (pendingMode !== null) {
            if (mode === pendingMode) pendingMode = null; // property caught up
            else                     mode = pendingMode; // property still stale
        }

        const { h, v, fully } = modeToState(mode, w.fullScreen || false);

        console.info(
            "[MaximizeDetector] evaluateState:", w.caption,
            "mode=", mode, "wasFully=", wasFully,
            "active=", workspace.activeWindow === w
        );

        if (fully === wasFully) return;

        console.info(
            "[MaximizeDetector] State transition:", w.caption,
            "fully:", wasFully, "→", fully
        );

        wasFully = fully;

        if (workspace.activeWindow === w) {
            notify(w, h, v, fully);
        }
    };

    // Run once immediately to pick up windows already maximized at startup.
    console.info("[MaximizeDetector] Initial state check:", w.caption);
    evaluateState();

    // ------------------------------------------------------------------
    // 2. Geometry / fullscreen signals
    //    Catches silent maximization via startup rules.
    // ------------------------------------------------------------------
    w.frameGeometryChanged?.connect(evaluateState);
    w.geometryChanged?.connect(evaluateState);
    w.fullScreenChanged?.connect(evaluateState);

    // ------------------------------------------------------------------
    // 3. Explicit maximize / restore
    // ------------------------------------------------------------------
    w.maximizedAboutToChange?.connect((mode) => {
        console.info("[MaximizeDetector] maximizedAboutToChange:", w.caption, "mode=", mode);

        pendingMode = mode;
        wasFully    = (mode === MODE_FULL);

        const { h, v, fully } = modeToState(mode, w.fullScreen || false);

        if (workspace.activeWindow === w) {
            notify(w, h, v, fully);
        }
    });

    // ------------------------------------------------------------------
    // 4. Minimise / restore
    //    KWin preserves maximizeMode while a window is minimised, so we
    //    can read it directly rather than recalling it from a cache.
    // ------------------------------------------------------------------
    w.minimizedChanged?.connect(() => {
        const { h, v, fully } = currentState(w);
        console.info(
            "[MaximizeDetector] minimizedChanged:", w.caption,
            "minimized=", w.minimized, "fully=", fully
        );

        if (!fully) return; // wasn't maximized — nothing to tell the engine

        w.minimized
            ? notify(w, false, false, false)
            : notify(w, h, v, fully);
    });

    // ------------------------------------------------------------------
    // 5. Cleanup on close
    //    Both closure variables vanish with this scope automatically.
    // ------------------------------------------------------------------
    w.closed?.connect(() => {
        console.info("[MaximizeDetector] closed:", w.caption, "key=", key);
        connectedWindows.delete(key);
        if (wasFully) notify(w, false, false, false);
    });
};

// ---------------------------------------------------------------------------
// Focus handler
// ---------------------------------------------------------------------------

const onWindowActivated = (w) => {
    if (!w || w.specialWindow) return;
    if (!connectedWindows.has(windowKey(w))) return;  // ← bail if not yet connected

    const { h, v, fully } = currentState(w);
    console.info(
        "[MaximizeDetector] windowActivated:", w.caption,
        "pid=", w.pid, "fully=", fully
    );

    notify(w, h, v, fully);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const init = () => {
    console.info("[MaximizeDetector] Starting...");

    workspace.windowList().forEach(connectWindow);
    workspace.windowAdded.connect(connectWindow);
    workspace.windowActivated.connect(onWindowActivated);

    console.info("[MaximizeDetector] Init complete");
};

init();