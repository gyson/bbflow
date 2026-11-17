#!/bin/sh
# Simulated agent tool for the bbflow demo instance. It reads lines and prints fixed
# replies. It calls no model and uses no network.
#
# Usage:
#   sh demo-agent.sh                    Chat mode.
#   sh demo-agent.sh --busy             Print one progress line each second.
#   sh demo-agent.sh --handoff PROMPT   Chat mode. Show the handoff prompt first.
set -u

say() {
    printf '%s\n' "$*"
}

say 'demo-agent (simulated). No model. No network.'
say "Workspace: $(pwd)"

if [ "${1:-}" = --busy ]; then
    say 'Busy mode. Press Ctrl+C to stop.'
    step=0
    while :; do
        step=$((step + 1))
        say "step $step: simulated work in progress"
        sleep 1
    done
fi

if [ "${1:-}" = --handoff ]; then
    say 'Handoff prompt received:'
    say "  ${2:-}"
fi

say 'Commands: /work, /edit, /exit. Other text gets a fixed reply.'
turn=0
while :; do
    printf 'demo> '
    IFS= read -r line || break
    turn=$((turn + 1))
    case $line in
    /exit)
        break
        ;;
    /work)
        for step in 1 2 3 4 5 6; do
            say "step $step of 6: simulated work"
            sleep 0.5
        done
        say 'Work complete.'
        ;;
    /edit)
        say "- demo-agent note $turn" >> demo-agent-notes.md
        say 'Added one line to demo-agent-notes.md. See the Changes pane.'
        ;;
    '')
        ;;
    *)
        sleep 0.2
        say "Turn $turn. Simulated reply to: $line"
        say 'A real agent would read the workspace and answer here.'
        ;;
    esac
done
say 'Goodbye.'
