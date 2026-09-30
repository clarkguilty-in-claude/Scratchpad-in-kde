#!/usr/bin/env bash
# Opens the terminal that becomes the scratchpad.
# Run by kde-scratchpad-terminal@.service, which the KWin script starts on Meta+S.
set -uo pipefail

readonly default_terminal_command="konsole"

# Same setting the KWin script's settings page writes.
terminal_command="$(kreadconfig6 --file kwinrc --group Script-kde-scratchpad \
    --key TerminalCommand --default "$default_terminal_command" 2>/dev/null)"

# Split into words without going through a shell: arguments work
# (konsole --profile Scratchpad), but the setting is never run as shell code.
read -r -a terminal_argv <<< "$terminal_command"
if [[ ${#terminal_argv[@]} -eq 0 ]]; then
    terminal_argv=("$default_terminal_command")
fi

terminal_program="${terminal_argv[0]}"
if ! command -v "$terminal_program" >/dev/null 2>&1; then
    error_message="Can't find '$terminal_program'. Pick another terminal in System Settings > Window Management > KWin Scripts > Scratchpad."
    echo "$error_message" >&2
    if command -v notify-send >/dev/null 2>&1; then
        notify-send --app-name=Scratchpad --icon=dialog-error "Scratchpad" "$error_message"
    fi
    exit 1
fi

exec "${terminal_argv[@]}"
