#!/usr/bin/env bash
# Removes everything install.sh put in place.
set -uo pipefail

readonly script_id="kde-scratchpad"
readonly shortcut_names=(
    "Scratchpad: Toggle"
    "Scratchpad: Move Focused Window"
    "Scratchpad: Release Window"
)

# Hand the scratchpad window back first. Otherwise it stays hidden and out of
# the taskbar with nothing left to bring it back.
busctl --user call org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component \
    invokeShortcut s "Scratchpad: Release Window" >/dev/null 2>&1
sleep 0.5

busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting \
    unloadScript s "$script_id" >/dev/null 2>&1
kwriteconfig6 --file kwinrc --group Plugins --key "${script_id}Enabled" --delete
kpackagetool6 --type KWin/Script --remove "$script_id"

for shortcut_name in "${shortcut_names[@]}"; do
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
        unregister ss kwin "$shortcut_name" >/dev/null 2>&1
done

rm -f "$HOME/.config/systemd/user/kde-scratchpad-terminal@.service"
rm -rf "$HOME/.local/share/kde-scratchpad"
systemctl --user daemon-reload

echo "Scratchpad removed. Your settings are still in ~/.config/kwinrc under [Script-kde-scratchpad]."
