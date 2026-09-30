# Scratchpad for KDE Plasma

Press **Meta+S** (Super+S) to bring up a floating terminal on top of whatever you're doing, fullscreen apps included. Press it again to hide the terminal. The same terminal (and whatever is running in it) comes back every time.

Built for Fedora 44 KDE (Plasma 6, Wayland). It should work on any Plasma 6 desktop that runs on systemd.

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
| **Meta+S** | Empty scratchpad: opens a terminal and puts it in the scratchpad. Hidden: shows it on your current desktop and focuses it. Visible but not focused: focuses it. Focused: hides it. |
| **Meta+Shift+S** | Puts the focused window in the scratchpad (it replaces the one already there). If the focused window is the scratchpad, takes it back out so it's a normal window again. |

It always comes back exactly where you left it, with the same size. Move or resize it however you like and that's the spot it returns to. On a multi-monitor setup it stays on its own screen. The only exception is when that screen gets unplugged. Then it stays wherever KWin moved it.

If you close the terminal (`exit`, Ctrl+D), the scratchpad is empty again and the next Meta+S opens a new one.

While a window is in the scratchpad it stays on top of other windows and is left out of the taskbar and Alt+Tab. Meta+S is the way to get to it.

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
- Hidden = minimized. Shown = unminimized, kept on top and focused. Focusing it is what gets it above fullscreen windows. KWin only keeps a fullscreen window in its top layer while that window has focus.
- The script remembers the window's position and size every time you move or resize it. If anything shifted it while it was hidden, showing it puts it back.

## Troubleshooting

- **Meta+S does nothing.** Something else may already use Meta+S. Check System Settings > Keyboard > Shortcuts and search for "Scratchpad". Also check that "Scratchpad" is ticked under Window Management > KWin Scripts.
- **A terminal opens but doesn't act like a scratchpad.** The window didn't match the terminal window class. Set "Terminal window class" in the settings (see above).
- **No terminal opens.** Check the logs with `journalctl --user -b | grep -i scratchpad`, and try `systemctl --user start kde-scratchpad-terminal@test.service`.

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
