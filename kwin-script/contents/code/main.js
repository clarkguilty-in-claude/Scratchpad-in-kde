/*
 * Scratchpad for KDE Plasma 6.
 *
 * Keeps one window in a "scratchpad": a floating window that stays on top of
 * everything. Meta+S shows it on the current desktop and focuses it. If you can
 * see it, Meta+S hides it, whether it has focus or not. It always comes back
 * with the same position and size. If the scratchpad is empty, Meta+S opens a
 * terminal and that terminal becomes the scratchpad.
 *
 * KWin scripts can't start programs, so the terminal is started by asking
 * systemd to run kde-scratchpad-terminal@<n>.service (installed by install.sh).
 * The first matching window that opens after that becomes the scratchpad.
 *
 * Every step is logged with a "kde-scratchpad:" prefix:
 *   journalctl --user -b | grep kde-scratchpad
 */

const TERMINAL_UNIT_PREFIX = "kde-scratchpad-terminal@";
const TERMINAL_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_TERMINAL_COMMAND = "konsole";
const DEFAULT_SIZE_PERCENT = 60;
const LOG_PREFIX = "kde-scratchpad: ";

let settings = readSettings();
let scratchpadWindow = null;
// The window's flags from before it went into the scratchpad, so taking it back
// out leaves it the way it was.
let flagsBeforeScratchpad = null;
// Where the scratchpad was the last time it was on screen. Showing it puts it
// back exactly there.
let lastVisibleGeometry = null;
// When we last asked systemd for a terminal, or null if we aren't waiting for one.
let terminalRequestedAt = null;


// ---- Logging ----------------------------------------------------------------

function log(message) {
    console.info(LOG_PREFIX + message);
}

function warn(message) {
    console.warn(LOG_PREFIX + message);
}

// KWin throws away errors from shortcut handlers without a trace, so catch
// them here and log them with the line they came from.
function logErrors(actionName, handler) {
    return function () {
        try {
            handler.apply(null, arguments);
        } catch (error) {
            warn(actionName + " failed: " + error
                + (error && error.lineNumber ? " (main.js line " + error.lineNumber + ")" : ""));
        }
    };
}

// Only the app's class, never the window title: titles can hold paths or commands.
function describeWindow(window) {
    return String(window.resourceClass || window.desktopFileName || "unknown app")
        + " (" + String(window.resourceName || "?") + ")";
}


// ---- Settings (System Settings > Window Management > KWin Scripts) ----------

function readSettings() {
    const terminalCommand = String(readConfig("TerminalCommand", DEFAULT_TERMINAL_COMMAND)).trim()
        || DEFAULT_TERMINAL_COMMAND;
    const terminalWindowClass = String(readConfig("TerminalWindowClass", "")).trim()
        || programName(terminalCommand);
    return {
        // Used to recognise the terminal's window: "konsole" matches org.kde.konsole.
        terminalWindowClass: terminalWindowClass.toLowerCase(),
        widthPercent: toPercent(readConfig("WidthPercent", DEFAULT_SIZE_PERCENT)),
        heightPercent: toPercent(readConfig("HeightPercent", DEFAULT_SIZE_PERCENT)),
    };
}

function programName(command) {
    const firstWord = command.split(/\s+/)[0];
    return firstWord.substring(firstWord.lastIndexOf("/") + 1);
}

function toPercent(value) {
    const number = Number(value);
    if (!number) {
        return DEFAULT_SIZE_PERCENT;
    }
    return Math.min(100, Math.max(10, number));
}


// ---- Shortcut actions -------------------------------------------------------

// Meta+S. Empty: open a terminal. Visible (focused or not): hide it.
// Hidden, or completely covered: show it on top and focus it.
function toggleScratchpad() {
    if (!scratchpadWindow) {
        log("Meta+S: the scratchpad is empty, opening a terminal");
        startTerminal();
    } else if (isScratchpadVisible()) {
        log("Meta+S: hiding the scratchpad");
        hideScratchpad();
    } else {
        log("Meta+S: showing the scratchpad");
        showScratchpad();
    }
}

// Meta+Shift+S
function toggleFocusedWindowInScratchpad() {
    const focusedWindow = workspace.activeWindow;
    if (!focusedWindow) {
        return;
    }
    if (focusedWindow === scratchpadWindow) {
        log("Meta+Shift+S: taking " + describeWindow(focusedWindow) + " out of the scratchpad");
        releaseScratchpad();
        showOsd("Taken out of the scratchpad");
        return;
    }
    if (canBeScratchpad(focusedWindow)) {
        log("Meta+Shift+S: moving " + describeWindow(focusedWindow) + " into the scratchpad");
        moveIntoScratchpad(focusedWindow);
    }
}

// No default key. uninstall.sh calls this so the window doesn't stay hidden.
function releaseAndShowScratchpad() {
    const window = scratchpadWindow;
    if (!window) {
        return;
    }
    log("giving " + describeWindow(window) + " back as a normal window");
    releaseScratchpad();
    window.minimized = false;
    workspace.activeWindow = window;
}


// ---- Scratchpad state -------------------------------------------------------

function canBeScratchpad(window) {
    return !!window && window.normalWindow && !window.transient && window.minimizable;
}

function adopt(window) {
    scratchpadWindow = window;
    terminalRequestedAt = null;
    flagsBeforeScratchpad = {
        keepAbove: window.keepAbove,
        skipTaskbar: window.skipTaskbar,
        skipPager: window.skipPager,
        skipSwitcher: window.skipSwitcher,
    };
    lastVisibleGeometry = copyRect(window.frameGeometry);
    window.frameGeometryChanged.connect(rememberGeometry);

    // On top of other windows, and out of the taskbar, pager and Alt+Tab:
    // Meta+S is the way to reach it.
    window.keepAbove = true;
    window.skipTaskbar = true;
    window.skipPager = true;
    window.skipSwitcher = true;
}

function forgetScratchpad() {
    scratchpadWindow.frameGeometryChanged.disconnect(rememberGeometry);
    scratchpadWindow = null;
    flagsBeforeScratchpad = null;
    lastVisibleGeometry = null;
}

function moveIntoScratchpad(window) {
    if (scratchpadWindow) {
        releaseScratchpad();
    }
    adopt(window);
    hideScratchpad();
    showOsd("Moved to the scratchpad");
}

function releaseScratchpad() {
    const window = scratchpadWindow;
    // Unknown when we picked the window up after a script reload; assume plain defaults.
    const originalFlags = flagsBeforeScratchpad
        || { keepAbove: false, skipTaskbar: false, skipPager: false, skipSwitcher: false };
    forgetScratchpad();
    unpinFromOtherWindows(window);

    window.keepAbove = originalFlags.keepAbove;
    window.skipTaskbar = originalFlags.skipTaskbar;
    window.skipPager = originalFlags.skipPager;
    window.skipSwitcher = originalFlags.skipSwitcher;
}

// If KWin reloads this script (after an update, for example), the old scratchpad
// window is still around with our flags on it. Pick it up again instead of
// leaving it hidden with no way to reach it.
function findLeftoverScratchpad() {
    const windows = workspace.windowList();
    for (let index = 0; index < windows.length; index++) {
        const window = windows[index];
        if (canBeScratchpad(window) && window.skipTaskbar && window.skipPager
            && window.skipSwitcher) {
            return window;
        }
    }
    return null;
}


// ---- Showing and hiding -----------------------------------------------------

// Visible = not minimized, on the desktop and activity you're looking at, and
// not completely covered by a fullscreen window. Focus doesn't matter.
function isScratchpadVisible() {
    const window = scratchpadWindow;
    return !window.minimized && isOnCurrentDesktop(window) && isOnCurrentActivity(window)
        && !isCoveredByFullscreenWindow(window);
}

function isOnCurrentDesktop(window) {
    if (window.onAllDesktops) {
        return true;
    }
    const currentDesktopId = workspace.currentDesktop.id;
    const windowDesktops = window.desktops;
    for (let index = 0; index < windowDesktops.length; index++) {
        if (windowDesktops[index].id === currentDesktopId) {
            return true;
        }
    }
    return false;
}

function isOnCurrentActivity(window) {
    // An empty activity list means "on all activities".
    const currentActivity = workspace.currentActivity;
    const windowActivities = window.activities;
    return !currentActivity || windowActivities.length === 0
        || windowActivities.indexOf(currentActivity) !== -1;
}

// Looks at KWin's real stacking order (bottom to top): is a fullscreen window on
// the same screen stacked above the scratchpad?
function isCoveredByFullscreenWindow(window) {
    const stackingOrder = workspace.stackingOrder;
    const windowScreen = screenName(window);
    for (let index = stackingOrder.indexOf(window) + 1; index < stackingOrder.length; index++) {
        const other = stackingOrder[index];
        if (other !== window && other.fullScreen && !other.minimized && !other.deleted
            && isOnCurrentDesktop(other) && screenName(other) === windowScreen) {
            return true;
        }
    }
    return false;
}

function screenName(window) {
    return window.output ? window.output.name : "";
}

function showScratchpad() {
    const window = scratchpadWindow;
    // Read it before un-minimizing: if KWin moved the window while it was
    // hidden, that move would otherwise be remembered as the new spot.
    const geometryToRestore = lastVisibleGeometry;

    bringToCurrentDesktopAndActivity(window);
    window.keepAbove = true;
    pinAboveFullscreenAndPinnedWindows(window);
    window.minimized = false;
    restoreGeometry(window, geometryToRestore);
    workspace.activeWindow = window;
    workspace.raiseWindow(window);
}

function hideScratchpad() {
    scratchpadWindow.minimized = true;
}

function bringToCurrentDesktopAndActivity(window) {
    if (!isOnCurrentDesktop(window)) {
        window.desktops = [workspace.currentDesktop];
    }
    if (!isOnCurrentActivity(window)) {
        window.activities = [workspace.currentActivity];
    }
}

// Keep-above puts the scratchpad over normal windows. Fullscreen windows (while
// they have focus) and other keep-above windows can still end up over it, so
// tell KWin to keep the scratchpad above each of those that's open right now.
// Windows that go fullscreen later can still cover it, the way a screenshot
// tool's overlay should. KWin drops these rules itself when a window closes.
function pinAboveFullscreenAndPinnedWindows(window) {
    if (typeof workspace.constrain !== "function") {
        return; // KWin older than 6.5
    }
    const windows = workspace.windowList();
    for (let index = 0; index < windows.length; index++) {
        const other = windows[index];
        if (other !== window && other.normalWindow && !other.transient
            && (other.fullScreen || other.keepAbove)) {
            workspace.constrain(other, window);
        }
    }
}

function unpinFromOtherWindows(window) {
    if (typeof workspace.unconstrain !== "function") {
        return;
    }
    const windows = workspace.windowList();
    for (let index = 0; index < windows.length; index++) {
        workspace.unconstrain(windows[index], window);
    }
}


// ---- Position and size ------------------------------------------------------

// Runs every time the scratchpad moves or resizes, including while you drag it.
function rememberGeometry() {
    if (scratchpadWindow && !scratchpadWindow.minimized) {
        lastVisibleGeometry = copyRect(scratchpadWindow.frameGeometry);
    }
}

function restoreGeometry(window, geometry) {
    if (!geometry || isSameRect(window.frameGeometry, geometry)) {
        return;
    }
    // Skip it if that spot is on a screen that has since been unplugged.
    if (!isOnAnyScreen(geometry)) {
        return;
    }
    window.frameGeometry = copyRect(geometry);
}

function isOnAnyScreen(rect) {
    const screens = workspace.screens;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    for (let index = 0; index < screens.length; index++) {
        const screenArea = screens[index].geometry;
        if (centerX >= screenArea.x && centerX < screenArea.x + screenArea.width
            && centerY >= screenArea.y && centerY < screenArea.y + screenArea.height) {
            return true;
        }
    }
    return false;
}

function copyRect(rect) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isSameRect(first, second) {
    return first.x === second.x && first.y === second.y
        && first.width === second.width && first.height === second.height;
}

// Only for a freshly opened terminal. After that it keeps wherever you put it.
function centerNewTerminal(window) {
    const area = workspace.clientArea(KWin.MaximizeArea, workspace.activeScreen, workspace.currentDesktop);
    const width = Math.round(area.width * settings.widthPercent / 100);
    const height = Math.round(area.height * settings.heightPercent / 100);
    window.frameGeometry = {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width: width,
        height: height,
    };
}

function showOsd(text) {
    callDBus("org.kde.plasmashell", "/org/kde/osdService", "org.kde.osdService",
        "showText", "utilities-terminal", text);
}


// ---- Starting the terminal --------------------------------------------------

function isWaitingForTerminal() {
    return terminalRequestedAt !== null
        && Date.now() - terminalRequestedAt < TERMINAL_STARTUP_TIMEOUT_MS;
}

// Clears a terminal request that never turned into a window, and says so.
function forgetExpiredTerminalRequest() {
    if (terminalRequestedAt === null || isWaitingForTerminal()) {
        return;
    }
    warn("no window with class \"" + settings.terminalWindowClass + "\" opened within "
        + TERMINAL_STARTUP_TIMEOUT_MS / 1000 + " s of asking for a terminal. "
        + "Run ./doctor.sh from the Scratchpad-in-kde folder to find out why.");
    terminalRequestedAt = null;
}

function startTerminal() {
    forgetExpiredTerminalRequest();
    if (isWaitingForTerminal()) {
        log("still waiting for the terminal from the last Meta+S");
        return;
    }
    terminalRequestedAt = Date.now();
    // A new instance name every time, so systemd starts a fresh terminal even if
    // an earlier one (say, a window taken out of the scratchpad) is still running.
    const unitName = TERMINAL_UNIT_PREFIX + terminalRequestedAt + ".service";
    log("asking systemd to start " + unitName);
    // With a reply callback, KWin also logs systemd's error if the start fails.
    callDBus("org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "StartUnit", unitName, "replace",
        () => log("systemd accepted " + unitName + ", waiting for its window"));
}

// Matches the whole class or one dot-separated part of it: "konsole" matches
// org.kde.konsole and "wezterm" matches org.wezfurlong.wezterm, but "st" doesn't
// match steam.
function looksLikeTheTerminal(window) {
    const expectedName = settings.terminalWindowClass;
    return [window.resourceClass, window.resourceName, window.desktopFileName].some(name => {
        const lowerCaseName = String(name || "").toLowerCase();
        return lowerCaseName === expectedName || lowerCaseName.split(".").indexOf(expectedName) !== -1;
    });
}

function onWindowAdded(window) {
    forgetExpiredTerminalRequest();
    if (terminalRequestedAt === null || scratchpadWindow || !canBeScratchpad(window)) {
        return;
    }
    if (!looksLikeTheTerminal(window)) {
        log("waiting for a \"" + settings.terminalWindowClass + "\" window, ignoring a new "
            + describeWindow(window) + " window");
        return;
    }
    log("the new " + describeWindow(window) + " window is now the scratchpad");
    adopt(window);
    centerNewTerminal(window);
    showScratchpad();
}

function onWindowRemoved(window) {
    if (window === scratchpadWindow) {
        log("the scratchpad window closed, the next Meta+S opens a new terminal");
        forgetScratchpad();
    }
}


// ---- Wiring -----------------------------------------------------------------

registerShortcut("Scratchpad: Toggle", "Scratchpad: Show or hide",
    "Meta+S", logErrors("Meta+S", toggleScratchpad));
registerShortcut("Scratchpad: Move Focused Window", "Scratchpad: Move focused window in or out",
    "Meta+Shift+S", logErrors("Meta+Shift+S", toggleFocusedWindowInScratchpad));
registerShortcut("Scratchpad: Release Window", "Scratchpad: Take the window out and show it",
    "", logErrors("releasing the scratchpad", releaseAndShowScratchpad));

workspace.windowAdded.connect(logErrors("handling a new window", onWindowAdded));
workspace.windowRemoved.connect(logErrors("handling a closed window", onWindowRemoved));
options.configChanged.connect(() => {
    settings = readSettings();
});

const leftoverScratchpad = findLeftoverScratchpad();
if (leftoverScratchpad) {
    adopt(leftoverScratchpad);
    flagsBeforeScratchpad = null; // what we'd record now are our own flags
    log("picked up " + describeWindow(leftoverScratchpad) + " again as the scratchpad");
}
log("loaded (terminal window class: \"" + settings.terminalWindowClass + "\")");
