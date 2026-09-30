// Runs the KWin script against a small fake of KWin's scripting API.
// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const scriptSource = readFileSync(
    new URL("../kwin-script/contents/code/main.js", import.meta.url), "utf8");

function makeSignal() {
    const handlers = [];
    return {
        connect: handler => handlers.push(handler),
        emit: (...args) => handlers.forEach(handler => handler(...args)),
    };
}

// Two 1920x1080 screens side by side, each with a 40px panel at the bottom.
const leftScreen = { name: "DP-1", x: 0 };
const rightScreen = { name: "HDMI-1", x: 1920 };
const desktopOne = { name: "Desktop 1" };
const desktopTwo = { name: "Desktop 2" };

function screenAtX(x) {
    return x >= rightScreen.x ? rightScreen : leftScreen;
}

class FakeWindow {
    constructor(fakeKwin, properties = {}) {
        this.fakeKwin = fakeKwin;
        this.normalWindow = true;
        this.transient = false;
        this.minimizable = true;
        this.resourceClass = "";
        this.resourceName = "";
        this.desktopFileName = "";
        this.keepAbove = false;
        this.skipTaskbar = false;
        this.skipPager = false;
        this.skipSwitcher = false;
        this.onAllDesktops = false;
        this.desktops = [desktopOne];
        this.activities = [];
        this.isMinimized = false;
        this.geometry = { x: 100, y: 100, width: 800, height: 500 };
        Object.assign(this, properties);
    }
    get frameGeometry() { return this.geometry; }
    set frameGeometry(rect) { this.geometry = { ...rect }; }
    get output() { return screenAtX(this.geometry.x); }
    get width() { return this.geometry.width; }
    get height() { return this.geometry.height; }
    get minimized() { return this.isMinimized; }
    set minimized(value) {
        this.isMinimized = value;
        // KWin moves focus elsewhere when the focused window is minimized.
        if (value && this.fakeKwin.workspace.activeWindow === this) {
            this.fakeKwin.workspace.activeWindow = null;
        }
    }
}

function loadScript({ config = {}, existingWindows = [] } = {}) {
    let now = 1_000_000;
    let focusedWindow = null;
    const shortcuts = {};
    const dbusCalls = [];
    const windows = [];

    const fakeKwin = {};
    fakeKwin.workspace = {
        get activeWindow() { return focusedWindow; },
        set activeWindow(window) {
            focusedWindow = window;
            if (window) {
                window.isMinimized = false;
            }
        },
        currentDesktop: desktopOne,
        currentActivity: "activity-1",
        activeScreen: leftScreen,
        windowAdded: makeSignal(),
        windowRemoved: makeSignal(),
        windowList: () => windows.slice(),
        clientArea: (option, screen) => ({ x: screen.x, y: 0, width: 1920, height: 1040 }),
        raiseWindow: () => {},
    };

    for (const properties of existingWindows) {
        windows.push(new FakeWindow(fakeKwin, properties));
    }

    const context = vm.createContext({
        workspace: fakeKwin.workspace,
        options: { configChanged: makeSignal() },
        KWin: { MaximizeArea: 2 },
        Date: { now: () => now },
        readConfig: (key, defaultValue) => (key in config ? config[key] : defaultValue),
        registerShortcut: (name, text, keys, callback) => { shortcuts[name] = { keys, callback }; },
        callDBus: (...args) => dbusCalls.push(args),
        print: () => {},
    });
    vm.runInContext(scriptSource, context);

    return {
        workspace: fakeKwin.workspace,
        shortcuts,
        dbusCalls,
        windows,
        scratchpad: () => vm.runInContext("scratchpadWindow", context),
        press: keys => Object.values(shortcuts).find(shortcut => shortcut.keys === keys).callback(),
        advanceTime: milliseconds => { now += milliseconds; },
        openWindow(properties) {
            const window = new FakeWindow(fakeKwin, properties);
            windows.push(window);
            fakeKwin.workspace.windowAdded.emit(window);
            return window;
        },
        closeWindow(window) {
            windows.splice(windows.indexOf(window), 1);
            if (focusedWindow === window) {
                focusedWindow = null;
            }
            fakeKwin.workspace.windowRemoved.emit(window);
        },
        focus(window) { fakeKwin.workspace.activeWindow = window; },
    };
}

const terminalLaunches = kwin => kwin.dbusCalls.filter(call => call[3] === "StartUnit");
const openKonsole = kwin => kwin.openWindow({ resourceClass: "org.kde.konsole", desktopFileName: "org.kde.konsole" });

test("registers Meta+S and Meta+Shift+S", () => {
    const kwin = loadScript();
    const keys = Object.values(kwin.shortcuts).map(shortcut => shortcut.keys);
    assert.deepEqual(keys.sort(), ["", "Meta+S", "Meta+Shift+S"]);
});

test("Meta+S on an empty scratchpad starts one terminal through systemd", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    kwin.press("Meta+S"); // pressed again while the terminal is still starting

    const launches = terminalLaunches(kwin);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].slice(0, 3),
        ["org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager"]);
    assert.match(launches[0][4], /^kde-scratchpad-terminal@\d+\.service$/);
    assert.equal(launches[0][5], "replace");
});

test("the terminal window becomes a centered, focused, always-on-top scratchpad", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    const unrelatedWindow = kwin.openWindow({ resourceClass: "firefox" });
    const terminal = openKonsole(kwin);

    assert.equal(kwin.scratchpad(), terminal);
    assert.notEqual(kwin.scratchpad(), unrelatedWindow);
    assert.equal(kwin.workspace.activeWindow, terminal);
    assert.equal(terminal.keepAbove, true);
    assert.equal(terminal.skipTaskbar, true);
    assert.equal(terminal.skipPager, true);
    assert.equal(terminal.skipSwitcher, true);
    assert.deepEqual(terminal.frameGeometry, { x: 384, y: 208, width: 1152, height: 624 });
});

test("a terminal that shows up long after the key press is left alone", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    kwin.advanceTime(20_000);
    openKonsole(kwin);
    assert.equal(kwin.scratchpad(), null);
});

test("later presses hide and show it", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    const terminal = openKonsole(kwin);

    kwin.press("Meta+S");
    assert.equal(terminal.minimized, true);
    assert.notEqual(kwin.workspace.activeWindow, terminal);

    kwin.press("Meta+S");
    assert.equal(terminal.minimized, false);
    assert.equal(kwin.workspace.activeWindow, terminal);
    assert.equal(terminalLaunches(kwin).length, 1);
});

test("if it's visible but another window has focus, Meta+S focuses it instead of hiding it", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    const terminal = openKonsole(kwin);
    kwin.focus(kwin.openWindow({ resourceClass: "firefox" }));

    kwin.press("Meta+S");
    assert.equal(terminal.minimized, false);
    assert.equal(kwin.workspace.activeWindow, terminal);
});

test("it follows you to the current desktop, activity and screen", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    const terminal = openKonsole(kwin);
    kwin.press("Meta+S");

    terminal.activities = ["activity-1"];
    kwin.workspace.currentDesktop = desktopTwo;
    kwin.workspace.currentActivity = "activity-2";
    kwin.workspace.activeScreen = rightScreen;
    kwin.press("Meta+S");

    // Arrays made inside the vm sandbox have their own prototype, so copy them out first.
    assert.deepEqual([...terminal.desktops], [desktopTwo]);
    assert.deepEqual([...terminal.activities], ["activity-2"]);
    assert.equal(terminal.output, rightScreen);
    assert.equal(terminal.width, 1152);
});

test("closing the scratchpad terminal means the next Meta+S opens a new one", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    kwin.closeWindow(openKonsole(kwin));
    assert.equal(kwin.scratchpad(), null);

    kwin.advanceTime(1);
    kwin.press("Meta+S");
    const launches = terminalLaunches(kwin);
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0][4], launches[1][4]);
});

test("the terminal is recognised by the configured command or window class", () => {
    const alacritty = loadScript({ config: { TerminalCommand: "/usr/bin/alacritty -o font.size=12" } });
    alacritty.press("Meta+S");
    openKonsole(alacritty);
    const alacrittyWindow = alacritty.openWindow({ resourceClass: "Alacritty" });
    assert.equal(alacritty.scratchpad(), alacrittyWindow);

    const wezterm = loadScript({
        config: { TerminalCommand: "flatpak run org.wezfurlong.wezterm", TerminalWindowClass: "wezterm" },
    });
    wezterm.press("Meta+S");
    const weztermWindow = wezterm.openWindow({ desktopFileName: "org.wezfurlong.wezterm" });
    assert.equal(wezterm.scratchpad(), weztermWindow);
});

test("with UseFocusedWindowWhenEmpty, Meta+S puts the focused window in the scratchpad", () => {
    const kwin = loadScript({ config: { UseFocusedWindowWhenEmpty: true } });
    const editor = kwin.openWindow({ resourceClass: "kate" });
    kwin.focus(editor);

    kwin.press("Meta+S");
    assert.equal(kwin.scratchpad(), editor);
    assert.equal(editor.minimized, true);
    assert.equal(terminalLaunches(kwin).length, 0);
    assert.ok(kwin.dbusCalls.some(call => call[3] === "showText"));

    kwin.press("Meta+S");
    assert.equal(kwin.workspace.activeWindow, editor);
});

test("Meta+Shift+S moves the focused window in, and back out with its old flags", () => {
    const kwin = loadScript();
    const editor = kwin.openWindow({ resourceClass: "kate", keepAbove: true });
    kwin.focus(editor);

    kwin.press("Meta+Shift+S");
    assert.equal(kwin.scratchpad(), editor);
    assert.equal(editor.minimized, true);

    kwin.press("Meta+S");
    kwin.press("Meta+Shift+S");
    assert.equal(kwin.scratchpad(), null);
    assert.equal(editor.keepAbove, true);
    assert.equal(editor.skipTaskbar, false);
    assert.equal(editor.skipSwitcher, false);
});

test("Meta+Shift+S on a second window swaps it in and gives the first one back", () => {
    const kwin = loadScript();
    const first = kwin.openWindow({ resourceClass: "kate" });
    const second = kwin.openWindow({ resourceClass: "dolphin" });
    kwin.focus(first);
    kwin.press("Meta+Shift+S");
    kwin.focus(second);
    kwin.press("Meta+Shift+S");

    assert.equal(kwin.scratchpad(), second);
    assert.equal(first.skipTaskbar, false);
});

test("dialogs and other special windows can't become the scratchpad", () => {
    const kwin = loadScript();
    const dialog = kwin.openWindow({ normalWindow: false });
    kwin.focus(dialog);
    kwin.press("Meta+Shift+S");
    assert.equal(kwin.scratchpad(), null);
});

test("the release action (used by uninstall.sh) shows the window and restores it", () => {
    const kwin = loadScript();
    kwin.press("Meta+S");
    const terminal = openKonsole(kwin);
    kwin.press("Meta+S");

    kwin.shortcuts["Scratchpad: Release Window"].callback();
    assert.equal(kwin.scratchpad(), null);
    assert.equal(terminal.minimized, false);
    assert.equal(terminal.skipTaskbar, false);
    assert.equal(kwin.workspace.activeWindow, terminal);
});

test("after a script reload, the hidden scratchpad window is picked up again", () => {
    const kwin = loadScript({
        existingWindows: [
            { resourceClass: "firefox" },
            {
                resourceClass: "org.kde.konsole", keepAbove: true, skipTaskbar: true,
                skipPager: true, skipSwitcher: true, isMinimized: true,
            },
        ],
    });
    const leftover = kwin.windows[1];
    assert.equal(kwin.scratchpad(), leftover);

    kwin.press("Meta+S");
    assert.equal(kwin.workspace.activeWindow, leftover);
    assert.equal(terminalLaunches(kwin).length, 0);
});
