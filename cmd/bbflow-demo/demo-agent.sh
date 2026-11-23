#!/bin/sh
# Simulated agent tool for the bbflow demo instance. It reads lines and prints fixed
# replies. It calls no model and uses no network.
#
# Usage:
#   sh demo-agent.sh                    Chat mode.
#   sh demo-agent.sh --detail           Chat mode. Each reply has many lines.
#   sh demo-agent.sh --busy             Print one progress line each second.
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

detail=
if [ "${1:-}" = --detail ]; then
    detail=1
fi

# detail_reply prints a reply that is longer than one screen.
detail_reply() {
    step=0
    while [ "$step" -lt 36 ]; do
        step=$((step + 1))
        case $((step % 4)) in
        1) say "- Read internal/orbit/part$step.go" ;;
        2) say "    $((step * 7 + 20)) lines" ;;
        3) say "- Search \"period\" in internal/orbit" ;;
        0) say "    $((step / 4)) matches" ;;
        esac
    done
}

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
        if [ -n "$detail" ]; then
            detail_reply
        fi
        say 'A real agent would read the workspace and answer here.'
        ;;
    esac
done
say 'Goodbye.'
