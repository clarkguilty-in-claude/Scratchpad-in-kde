#!/usr/bin/env bash
# Opens the terminal that becomes the scratchpad.
# Run by kde-scratchpad-terminal@.service, which the KWin script starts on Meta+S.
set -uo pipefail

readonly default_terminal_command="konsole"

# Same setting the KWin script's settings page writes.
terminal_command="$(kreadconfig6 --file kwinrc --group Script-kde-scratchpad \
    --key TerminalCommand --default "$default_terminal_command" 2>/dev/null)"
if [[ -z "${terminal_command//[[:space:]]/}" ]]; then
    terminal_command="$default_terminal_command"
fi

read -r terminal_program _ <<< "$terminal_command"
if ! command -v "$terminal_program" >/dev/null 2>&1; then
    error_message="Can't find '$terminal_program'. Pick another terminal in System Settings > Window Management > KWin Scripts > Scratchpad."
    echo "$error_message" >&2
    if command -v notify-send >/dev/null 2>&1; then
        notify-send --app-name=Scratchpad --icon=dialog-error "Scratchpad" "$error_message"
    fi
    exit 1
fi

# Run through sh on purpose, so the setting can carry arguments
# (konsole --profile Scratchpad).
exec sh -c "exec $terminal_command"
