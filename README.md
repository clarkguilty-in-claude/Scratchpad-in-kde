# Scratchpad for KDE Plasma

Press **Meta+S** (Super+S) to bring up a floating terminal on top of whatever you're doing, fullscreen apps included. Press it again to hide the terminal. The same terminal (and whatever is running in it) comes back every time.

Built for Fedora 44 KDE (Plasma 6.6, Wayland). It should work on any Plasma 6 desktop that runs on systemd. Staying above fullscreen windows that have focus needs Plasma 6.5 or newer.

Inspired by the scratchpad feature in [instantOS](https://instantos.io). This project brings the same idea to KDE Plasma.

## Install

```sh
git clone https://github.com/clarkguilty-in-claude/Scratchpad-in-kde.git
cd Scratchpad-in-kde
./install.sh
```

No root needed. Everything goes in your home directory. Run `./install.sh` again after pulling updates.

## Keys

| Key | What it does |
| --- | --- |
| **Meta+S** | Opens a terminal **only** when the scratchpad is empty, and puts it in the scratchpad. If something is already in it, Meta+S never opens anything. It just shows it or hides it. You can see it: hides it, focused or not. Hidden: brings it up on your current desktop, on top and focused. |
| **Meta+Shift+S** | Puts the focused window in the scratchpad (it replaces the one already there). If the focused window is the scratchpad, takes it back out so it's a normal window again. |

It always comes back exactly where you left it, with the same size. Move or resize it however you like and that's the spot it returns to. On a multi-monitor setup it stays on its own screen. The only exception is when that screen gets unplugged. Then it stays wherever KWin moved it.

If you close the terminal (`exit`, Ctrl+D), the scratchpad is empty again and the next Meta+S opens a new one.

It stays on top of everything: windows you open or click afterwards stay underneath it, and so do fullscreen windows like a video you're watching. Whenever it shows up, it has focus. The one thing that can cover it is a window that goes fullscreen *after* it appeared, like a screenshot tool's overlay. If that happens, Meta+S brings the scratchpad back on top instead of hiding it.

While a window is in the scratchpad it's left out of the taskbar and Alt+Tab. Meta+S is the way to get to it.

To change the keys: System Settings > Keyboard > Shortcuts > KWin, then search for "Scratchpad".

## Settings

System Settings > Window Management > KWin Scripts > Scratchpad > configure (the settings button):

- **Terminal command.** Default is `konsole`. Arguments are fine too: `konsole --profile Scratchpad`, `alacritty`, `kitty`, `foot`, `ptyxis`. The command doesn't go through a shell, so quotes, pipes and `$VARIABLES` aren't interpreted. For anything fancier, point it at a script of your own.
- **Terminal window class.** Only needed if the command doesn't start with the terminal's own name (for example `flatpak run org.wezfurlong.wezterm`: set this to `wezterm`). It has to match the whole class or one dot-separated part of it, so `konsole` matches `org.kde.konsole` but `st` doesn't match `steam`.
- **Width / height.** How big a new scratchpad terminal is, as a percentage of the screen. Default is 60%. Once it's open, it keeps whatever size you give it.

Changes apply the next time KWin loads the script: turn it off and on again on that same page, run `./install.sh` again, or log out and back in.

## How it works

- `kwin-script/` is a KWin script (JavaScript that runs inside the window manager). It registers the shortcuts and does the showing, hiding, focusing and positioning.
- KWin scripts can't start programs. So when a terminal is needed, the script asks systemd to start `kde-scratchpad-terminal@<n>.service`, which runs `terminal/launch-terminal.sh`. The first window whose class matches your terminal and opens within 15 seconds becomes the scratchpad.
- Hidden = minimized. Shown = unminimized, kept above other windows ("keep above"), raised and focused. A fullscreen window with focus normally goes above keep-above windows, so the script also tells KWin to keep the scratchpad above the fullscreen and keep-above windows that are open when it appears (`workspace.constrain`, Plasma 6.5+).
- Every step is logged with a `kde-scratchpad:` prefix, so `journalctl --user -b | grep kde-scratchpad` shows what it did and why.
- The script remembers the window's position and size every time you move or resize it. If anything shifted it while it was hidden, showing it puts it back.

## Troubleshooting

Run this first:

```sh
./doctor.sh
```

It checks each step between the key press and the terminal: whether the script is installed, turned on and loaded, whether Meta+S really belongs to it (and if not, which other action has it), whether systemd can start a terminal that opens a window, and any errors the script logged. Then it presses Meta+S for you and shows what the script and the terminal did. Each failed check comes with a fix. `./install.sh` runs the same checks (without pressing Meta+S) when it finishes.

Common causes:

- **Meta+S does nothing.** Another action already has Meta+S, so KDE didn't give it to the scratchpad. `./doctor.sh` names that action.
- **A terminal opens but doesn't act like a scratchpad.** Its window class didn't match. `./doctor.sh` shows the class it saw, so you can put that in "Terminal window class".
- **No terminal opens.** `./doctor.sh` shows what systemd and the terminal logged.

## Uninstall

```sh
./uninstall.sh
```

This gives the scratchpad window back as a normal window first, so nothing gets stuck hidden.

## Development

The script logic is tested against a small fake of KWin's API (Node 18 or newer):

```sh
node --test tests/main.test.mjs
```
