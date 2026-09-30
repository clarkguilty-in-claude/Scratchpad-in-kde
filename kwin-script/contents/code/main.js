/*
 * Scratchpad for KDE Plasma 6.
 *
 * Keeps one window in a "scratchpad": a floating window that Meta+S pulls up on
 * top of everything (fullscreen windows included) on the current desktop and
 * screen, and hides again on the next press. If the scratchpad is empty, Meta+S
 * opens a terminal and that terminal becomes the scratchpad.
 *
 * KWin scripts can't start programs, so the terminal is started by asking
 * systemd to run kde-scratchpad-terminal@<n>.service (installed by install.sh).
 * The first matching window that opens after that becomes the scratchpad.
 */

const TERMINAL_UNIT_PREFIX = "kde-scratchpad-terminal@";
const TERMINAL_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_TERMINAL_COMMAND = "konsole";
const DEFAULT_SIZE_PERCENT = 60;

let settings = readSettings();
let scratchpadWindow = null;
// The window's flags from before it went into the scratchpad, so taking it back
// out leaves it the way it was.
let flagsBeforeScratchpad = null;
// When we last asked systemd for a terminal, or null if we aren't waiting for one.
let terminalRequestedAt = null;


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
        useFocusedWindowWhenEmpty: isTrue(readConfig("UseFocusedWindowWhenEmpty", false)),
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

function isTrue(value) {
    return value === true || String(value).toLowerCase() === "true";
}


// ---- Shortcut actions -------------------------------------------------------

// Meta+S
function toggleScratchpad() {
    if (scratchpadWindow) {
        if (isScratchpadFocused()) {
            hideScratchpad();
        } else {
            showScratchpad();
        }
        return;
    }

    const focusedWindow = workspace.activeWindow;
    if (settings.useFocusedWindowWhenEmpty && canBeScratchpad(focusedWindow)) {
        moveIntoScratchpad(focusedWindow);
        return;
    }
    startTerminal();
}

// Meta+Shift+S
function toggleFocusedWindowInScratchpad() {
    const focusedWindow = workspace.activeWindow;
    if (!focusedWindow) {
        return;
    }
    if (focusedWindow === scratchpadWindow) {
        releaseScratchpad();
        showOsd("Taken out of the scratchpad");
        return;
    }
    if (canBeScratchpad(focusedWindow)) {
        moveIntoScratchpad(focusedWindow);
    }
}

// No default key. uninstall.sh calls this so the window doesn't stay hidden.
function releaseAndShowScratchpad() {
    const window = scratchpadWindow;
    if (!window) {
        return;
    }
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
    // Kept out of the taskbar, pager and Alt+Tab: Meta+S is the way to reach it.
    window.keepAbove = true;
    window.skipTaskbar = true;
    window.skipPager = true;
    window.skipSwitcher = true;
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
    scratchpadWindow = null;
    flagsBeforeScratchpad = null;

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
        if (canBeScratchpad(window) && window.keepAbove && window.skipTaskbar
            && window.skipPager && window.skipSwitcher) {
            return window;
        }
    }
    return null;
}


// ---- Showing and hiding -----------------------------------------------------

function isScratchpadFocused() {
    return !scratchpadWindow.minimized && workspace.activeWindow === scratchpadWindow;
}

function showScratchpad() {
    const window = scratchpadWindow;
    bringToCurrentDesktopAndActivity(window);
    if (!isOnActiveScreen(window)) {
        centerOnActiveScreen(window, window.width, window.height);
    }
    window.keepAbove = true;
    window.minimized = false;
    // Focusing it also drops a fullscreen window out of KWin's top layer,
    // so the scratchpad ends up above it.
    workspace.activeWindow = window;
    if (typeof workspace.raiseWindow === "function") {
        workspace.raiseWindow(window);
    }
}

function hideScratchpad() {
    scratchpadWindow.minimized = true;
}

function bringToCurrentDesktopAndActivity(window) {
    if (!window.onAllDesktops) {
        window.desktops = [workspace.currentDesktop];
    }
    // An empty activity list means "on all activities".
    const currentActivity = workspace.currentActivity;
    const windowActivities = window.activities;
    if (currentActivity && windowActivities.length > 0
        && windowActivities.indexOf(currentActivity) === -1) {
        window.activities = [currentActivity];
    }
}

function isOnActiveScreen(window) {
    const activeScreen = workspace.activeScreen;
    return !!window.output && !!activeScreen && window.output.name === activeScreen.name;
}

function activeScreenArea() {
    return workspace.clientArea(KWin.MaximizeArea, workspace.activeScreen, workspace.currentDesktop);
}

function centerOnActiveScreen(window, width, height) {
    const area = activeScreenArea();
    const fittedWidth = Math.round(Math.min(width, area.width));
    const fittedHeight = Math.round(Math.min(height, area.height));
    window.frameGeometry = {
        x: Math.round(area.x + (area.width - fittedWidth) / 2),
        y: Math.round(area.y + (area.height - fittedHeight) / 2),
        width: fittedWidth,
        height: fittedHeight,
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

function startTerminal() {
    if (isWaitingForTerminal()) {
        return; // the one we asked for is still starting up
    }
    terminalRequestedAt = Date.now();
    // A new instance name every time, so systemd starts a fresh terminal even if
    // an earlier one (say, a window taken out of the scratchpad) is still running.
    const unitName = TERMINAL_UNIT_PREFIX + terminalRequestedAt + ".service";
    callDBus("org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "StartUnit", unitName, "replace");
}

function looksLikeTheTerminal(window) {
    const expectedClass = settings.terminalWindowClass;
    return [window.resourceClass, window.resourceName, window.desktopFileName]
        .some(name => String(name || "").toLowerCase().indexOf(expectedClass) !== -1);
}

function onWindowAdded(window) {
    if (!isWaitingForTerminal()) {
        terminalRequestedAt = null;
        return;
    }
    if (scratchpadWindow || !canBeScratchpad(window) || !looksLikeTheTerminal(window)) {
        return;
    }
    adopt(window);
    const area = activeScreenArea();
    centerOnActiveScreen(window,
        area.width * settings.widthPercent / 100,
        area.height * settings.heightPercent / 100);
    showScratchpad();
}

function onWindowRemoved(window) {
    if (window === scratchpadWindow) {
        scratchpadWindow = null;
        flagsBeforeScratchpad = null;
    }
}


// ---- Wiring -----------------------------------------------------------------

registerShortcut("Scratchpad: Toggle", "Scratchpad: Show or hide",
    "Meta+S", toggleScratchpad);
registerShortcut("Scratchpad: Move Focused Window", "Scratchpad: Move focused window in or out",
    "Meta+Shift+S", toggleFocusedWindowInScratchpad);
registerShortcut("Scratchpad: Release Window", "Scratchpad: Take the window out and show it",
    "", releaseAndShowScratchpad);

workspace.windowAdded.connect(onWindowAdded);
workspace.windowRemoved.connect(onWindowRemoved);
options.configChanged.connect(() => {
    settings = readSettings();
});

scratchpadWindow = findLeftoverScratchpad();
