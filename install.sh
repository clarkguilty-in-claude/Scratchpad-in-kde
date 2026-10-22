#!/usr/bin/env bash
# Installs (or updates) the scratchpad for the current user. No root needed.
# Run it again after pulling changes.
set -euo pipefail

readonly script_id="kde-scratchpad"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repo_dir
readonly launcher_path="$HOME/.local/share/kde-scratchpad/launch-terminal.sh"
readonly unit_name="kde-scratchpad-terminal@.service"
readonly unit_path="$HOME/.config/systemd/user/$unit_name"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing '$1'. $2" >&2
        exit 1
    fi
}

kwin_scripting() {
    busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting "$@"
}

require_command kpackagetool6 "This needs KDE Plasma 6 (Fedora package: kf6-kpackage)."
require_command kwriteconfig6 "This needs KDE Plasma 6 (Fedora package: kf6-kconfig)."
require_command kreadconfig6 "This needs KDE Plasma 6 (Fedora package: kf6-kconfig)."
require_command systemctl "This needs a systemd user session."
require_command busctl "This needs a systemd user session."

echo "Installing the terminal launcher..."
install -Dm755 "$repo_dir/terminal/launch-terminal.sh" "$launcher_path"
install -Dm644 "$repo_dir/terminal/$unit_name" "$unit_path"
systemctl --user daemon-reload

echo "Installing the KWin script..."
# Unload the running copy first so KWin picks up the new code.
kwin_scripting unloadScript s "$script_id" >/dev/null 2>&1 || true
kpackagetool6 --type KWin/Script --remove "$script_id" >/dev/null 2>&1 || true
kpackagetool6 --type KWin/Script --install "$repo_dir/kwin-script"

kwriteconfig6 --file kwinrc --group Plugins --key "${script_id}Enabled" true
kwin_scripting start

is_script_loaded() {
    kwin_scripting isScriptLoaded s "$script_id" 2>/dev/null | grep -q true
}

# KWin loads scripts in the background, and drops a script again if it fails
# while starting, so wait for it and then check that it's still there.
for _ in $(seq 1 10); do
    is_script_loaded && break
    sleep 0.5
done
sleep 1

echo
echo "Checking the install..."
"$repo_dir/doctor.sh" --no-press || true
echo
if is_script_loaded; then
    echo "Press Meta+S to open your scratchpad terminal."
    echo "If it doesn't work, run ./doctor.sh: it also presses Meta+S for you and shows what happened."
else
    cat >&2 <<'EOF'
KWin didn't keep the script loaded. The checks above should say why. If not,
turn on "Scratchpad" in System Settings > Window Management > KWin Scripts,
or log out and back in, then run ./doctor.sh.
EOF
    exit 1
fi
