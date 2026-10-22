#!/usr/bin/env bash
# Checks every step between pressing Meta+S and the scratchpad terminal showing
# up, and says which one is broken. It doesn't change anything, except that at
# the end it presses Meta+S once for you to test the whole chain (skip that
# with --no-press). Paste the output into a bug report if it doesn't help.
set -uo pipefail

readonly script_id="kde-scratchpad"
readonly toggle_action="Scratchpad: Toggle"
readonly meta_s_key=268435539 # Qt::META | Qt::Key_S, the way KDE sends Meta+S over D-Bus
readonly unit_name="kde-scratchpad-terminal@.service"
readonly data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
readonly launcher_path="$HOME/.local/share/kde-scratchpad/launch-terminal.sh"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repo_dir

press_meta_s=true
[[ "${1:-}" == "--no-press" ]] && press_meta_s=false

problem_count=0
script_is_loaded=false

pass() { printf '  [ ok ] %s\n' "$1"; }
note() { printf '         %s\n' "$1"; }
fail() {
    printf '  [FAIL] %s\n' "$1"
    [[ -n "${2:-}" ]] && printf '         Fix: %s\n' "$2"
    problem_count=$((problem_count + 1))
}

kwin_scripting() {
    busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting "$@" 2>/dev/null
}

# Calls the global shortcut daemon and prints the reply as JSON for python to read.
kglobalaccel_json() {
    busctl --user --json=short call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel "$@" 2>/dev/null
}

metadata_version() {
    sed -n 's/.*"Version": *"\([^"]*\)".*/\1/p' "$1" 2>/dev/null
}

script_journal_lines() {
    journalctl --user --no-pager -o cat "$@" 2>/dev/null | grep -E "kde-scratchpad|kwin_scripting"
}


echo "Session"
printf '         %s on %s, Plasma session type: %s\n' \
    "$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown OS}")" \
    "${XDG_CURRENT_DESKTOP:-unknown desktop}" "${XDG_SESSION_TYPE:-unknown}"
for tool in kpackagetool6 kreadconfig6 kwriteconfig6 busctl systemctl journalctl python3; do
    command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is missing" "install it, then run this again"
done


echo
echo "KWin script"
installed_dir=""
for candidate in "$data_home/kwin/scripts/$script_id" "$data_home/kwin-wayland/scripts/$script_id"; do
    [[ -f "$candidate/metadata.json" ]] && installed_dir="$candidate" && break
done
repo_version="$(metadata_version "$repo_dir/kwin-script/metadata.json")"
if [[ -z "$installed_dir" ]]; then
    fail "the script isn't installed" "run ./install.sh"
else
    installed_version="$(metadata_version "$installed_dir/metadata.json")"
    if [[ "$installed_version" == "$repo_version" ]]; then
        pass "version $installed_version is installed in $installed_dir"
    else
        fail "version $installed_version is installed, but this folder has $repo_version" "run ./install.sh"
    fi
fi

if [[ "$(kreadconfig6 --file kwinrc --group Plugins --key "${script_id}Enabled" 2>/dev/null)" == "true" ]]; then
    pass "it's turned on in KWin's settings"
else
    fail "it's turned off in KWin's settings" "run ./install.sh, or tick Scratchpad in System Settings > Window Management > KWin Scripts"
fi

if kwin_scripting isScriptLoaded s "$script_id" | grep -q true; then
    pass "KWin has it loaded"
    script_is_loaded=true
else
    fail "KWin doesn't have it loaded" "run ./install.sh, then look at the errors below"
fi

# Errors since the script last loaded: KWin's load errors, JavaScript exceptions,
# and the script's own "... failed:" lines. Older ones belong to older versions.
script_errors="$(journalctl --user -b --no-pager -o cat 2>/dev/null \
    | grep -E "$script_id/contents/code/main.js:[0-9]+|kde-scratchpad: .* failed: |kde-scratchpad: loaded" \
    | awk '/kde-scratchpad: loaded/ { errors = ""; next } { errors = errors $0 "\n" } END { printf "%s", errors }' \
    | tail -3)"
if [[ -n "$script_errors" ]]; then
    fail "the script hit errors since it last loaded:" "send these lines along with the rest of this output"
    while IFS= read -r line; do note "$line"; done <<< "$script_errors"
fi


echo
echo "Shortcut"
shortcut_state="$(kglobalaccel_json shortcutKeys as 4 kwin "$toggle_action" "" "" | python3 -c '
import json, sys
def numbers(value):
    if isinstance(value, list):
        for item in value:
            yield from numbers(item)
    elif isinstance(value, int):
        yield value
try:
    keys = [key for key in numbers(json.load(sys.stdin)["data"]) if key]
except Exception:
    print("unknown")
else:
    print("none" if not keys else "meta-s" if int(sys.argv[1]) in keys else "other")
' "$meta_s_key" 2>/dev/null)"
case "$shortcut_state" in
    meta-s) pass "\"$toggle_action\" is on Meta+S" ;;
    other) pass "\"$toggle_action\" is on a key you picked (not Meta+S)" ;;
    none)
        owner="$(kglobalaccel_json actionList "(ai)" 4 "$meta_s_key" 0 0 0 | python3 -c '
import json, sys
try:
    action = json.load(sys.stdin)["data"][0]
    print(action[2] + ": " + action[3] if len(action) == 4 else "")
except Exception:
    print("")
' 2>/dev/null)"
        if [[ -n "$owner" ]]; then
            fail "\"$toggle_action\" has no key, because Meta+S already belongs to \"$owner\"" \
                "remove Meta+S from that action in System Settings > Keyboard > Shortcuts, then give it to Scratchpad (search \"Scratchpad\")"
        else
            fail "\"$toggle_action\" has no key" "System Settings > Keyboard > Shortcuts, search \"Scratchpad\" and set Meta+S"
        fi
        ;;
    *) fail "couldn't ask KDE's shortcut service about \"$toggle_action\"" "is this a Plasma 6 session? The script must be loaded for the shortcut to exist" ;;
esac


echo
echo "Terminal launcher"
if systemctl --user cat "$unit_name" >/dev/null 2>&1; then
    pass "systemd knows $unit_name"
else
    fail "systemd doesn't know $unit_name" "run ./install.sh"
fi
if [[ -x "$launcher_path" ]]; then
    pass "the launcher is at $launcher_path"
else
    fail "the launcher is missing at $launcher_path" "run ./install.sh"
fi

systemd_environment="$(systemctl --user show-environment 2>/dev/null)"
if grep -q '^WAYLAND_DISPLAY=' <<< "$systemd_environment"; then
    pass "systemd has WAYLAND_DISPLAY, so terminals it starts can open windows"
else
    fail "systemd has no WAYLAND_DISPLAY, so a terminal it starts can't open a window" \
        "run: systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP, then try Meta+S again"
fi

terminal_command="$(kreadconfig6 --file kwinrc --group "Script-$script_id" --key TerminalCommand --default konsole 2>/dev/null)"
read -r terminal_program _ <<< "${terminal_command:-konsole}"
systemd_path="$(sed -n 's/^PATH=//p' <<< "$systemd_environment")"
if PATH="${systemd_path:-$PATH}" command -v "$terminal_program" >/dev/null 2>&1; then
    pass "the terminal command \"$terminal_command\" is found on systemd's PATH"
else
    fail "\"$terminal_program\" isn't on systemd's PATH (${systemd_path:-unknown})" \
        "install it, or set another terminal in the script's settings"
fi


if $press_meta_s && $script_is_loaded; then
    echo
    echo "Live test: pressing Meta+S for you (takes up to 8 seconds)"
    test_started_at="$(date +%s)"
    busctl --user call org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component \
        invokeShortcut s "$toggle_action" >/dev/null 2>&1

    outcome=""
    for _ in $(seq 1 16); do
        sleep 0.5
        live_log="$(script_journal_lines --since "@$test_started_at")"
        if grep -qE "is now the scratchpad|Meta\+S: (showing|hiding)" <<< "$live_log"; then
            outcome="worked"
            break
        fi
        if grep -qE "Received D-Bus message is error|no window with class| failed: " <<< "$live_log"; then
            outcome="failed"
            break
        fi
    done

    terminal_log="$(journalctl --user --no-pager -o cat --since "@$test_started_at" -u 'kde-scratchpad-terminal@*' 2>/dev/null | tail -5)"
    if [[ "$outcome" == "worked" ]]; then
        pass "the script got Meta+S and did its job"
    elif [[ -z "$live_log" ]]; then
        fail "no log lines from the script after pressing Meta+S" \
            "KWin's log may not be in your journal. Check with: journalctl --user -b | grep kde-scratchpad"
    elif grep -q " failed: " <<< "$live_log"; then
        fail "the script hit an error while handling Meta+S" "send the lines below along with the rest of this output"
    elif grep -q "Received D-Bus message is error" <<< "$live_log"; then
        fail "systemd refused to start the terminal" "see the systemd error below; ./install.sh puts the unit in place"
    elif grep -q "ignoring a new" <<< "$live_log"; then
        fail "a window opened, but its class didn't match the terminal window class setting" \
            "put the class shown below in Terminal window class (System Settings > Window Management > KWin Scripts > Scratchpad)"
    else
        fail "the script asked for a terminal, but no terminal window showed up" "look at the terminal's own log below"
    fi
    [[ -n "$live_log" ]] && { note "What the script logged:"; while IFS= read -r line; do note "  $line"; done <<< "$live_log"; }
    [[ -n "$terminal_log" ]] && { note "What the terminal service logged:"; while IFS= read -r line; do note "  $line"; done <<< "$terminal_log"; }
fi


echo
if [[ $problem_count -eq 0 ]]; then
    echo "Everything checks out."
else
    echo "Found $problem_count problem(s). Fix them from the top down, since later ones are often caused by earlier ones."
fi
