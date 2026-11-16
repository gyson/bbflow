#!/bin/sh
# Wait for the next review-loop event on a GitHub pull request (PR).
# SKILL.md in the parent folder describes the round comments and the events.
set -eu

usage() {
	cat >&2 <<'EOF'
Usage: wait-for-pr.sh review|fix PR --until EPOCH [options]

  review              Wait as the reviewer.
  fix                 Wait as the implementer.
  PR                  A pull request number or URL.
  --until EPOCH       The loop deadline, in seconds since the epoch. Required.
  --slice SECONDS     The longest time that one call waits. 0 waits until the
                      deadline. Default: 540.
  --interval SECONDS  The time between two checks. Default: 60.
  --settle SECONDS    review only. Without a READY comment, new commits start
                      a review after the head commit stays the same for this
                      time. Default: 180.
  --max-rounds N      The number of review rounds. Default: 5.
  --author LOGIN      The account that posts the round comments. Default: the
                      account of the gh command.

Exit status:
   0  event=review or event=fix. Do the next round.
  10  event=done. The reviewer posted LGTM.
  11  event=closed. The PR is merged or closed.
  12  event=timeout. The deadline passed.
  13  event=waiting. The slice ended. Run the same command again.
  14  event=limit. The last permitted review round did not end with LGTM.
   2  Incorrect arguments, a gh failure, or an incorrect round comment.
EOF
	exit 2
}

fail() {
	printf 'wait-for-pr: %s\n' "$1" >&2
	exit 2
}

finish() {
	printf '%s\n' "$2"
	exit "$1"
}

[ $# -ge 2 ] || usage
role=$1
pr=$2
shift 2
case $role in review | fix) ;; *) usage ;; esac

deadline=''
slice=540
interval=60
settle=180
max_rounds=5
author=''
while [ $# -gt 0 ]; do
	[ $# -ge 2 ] || usage
	case $1 in
	--until) deadline=$2 ;;
	--slice) slice=$2 ;;
	--interval) interval=$2 ;;
	--settle) settle=$2 ;;
	--max-rounds) max_rounds=$2 ;;
	--author) author=$2 ;;
	*) usage ;;
	esac
	shift 2
done
for value in "$deadline" "$slice" "$interval" "$settle" "$max_rounds"; do
	case $value in '' | *[!0-9]*) usage ;; esac
done
[ "$interval" -ge 1 ] || usage

if [ -z "$author" ]; then
	author=$(gh api user --jq .login) || fail 'cannot read the gh account; run gh auth status'
fi
case $author in '' | *[!A-Za-z0-9_-]*) fail "unsupported account name: $author" ;; esac

# Round comments start with a fixed first line. Only comments from the selected
# account count, so other accounts cannot start a round.
filter='"state\t\(.state)", "head\t\(.headRefOid)", (.comments | sort_by(.createdAt)[] | select(.author.login == "'$author'") | (.body | split("\n")[0] | rtrimstr("\r")) | select(startswith("**[review-loop ")) | "mark\t\(.)")'

# Print: state, head commit, position and round and commit and verdict of the latest
# reviewer comment, position of the latest implementer comment. A position of 0 means
# that the role posted no round comment.
snapshot() {
	raw=$(gh pr view "$pr" --json state,headRefOid,comments --jq "$filter") || return 1
	printf '%s\n' "$raw" | awk -F '\t' '
		function part(line, pattern, skip) {
			return match(line, pattern) ? substr(line, RSTART + skip, RLENGTH - skip) : ""
		}
		$1 == "state" { state = $2 }
		$1 == "head" { head = $2 }
		$1 == "mark" {
			count++
			if (index($2, "[review-loop reviewer]") == 3) {
				reviewAt = count
				round = part($2, "round [0-9]+", 6)
				commit = part($2, "commit [0-9a-f]+", 7)
				verdict = index($2, "LGTM") ? "lgtm" : "changes"
			} else if (index($2, "[review-loop implementer]") == 3) {
				fixAt = count
			}
		}
		END {
			if (state == "" || head == "") exit 1
			if (reviewAt && (round == "" || length(commit) < 7)) { round = "bad"; commit = "bad" }
			print state, head, reviewAt + 0, (round == "" ? 0 : round), (commit == "" ? "-" : commit), (verdict == "" ? "-" : verdict), fixAt + 0
		}'
}

now=$(date +%s)
if [ "$slice" -gt 0 ]; then
	slice_end=$((now + slice))
else
	slice_end=$deadline
fi
failures=0
seen_head=''
seen_at=0

while :; do
	now=$(date +%s)
	code=''
	text=''
	if line=$(snapshot); then
		failures=0
		# shellcheck disable=SC2086
		set -- $line
		state=$1 head=$2 review_at=$3 round=$4 commit=$5 verdict=$6 fix_at=$7
		[ "$round" != bad ] || fail 'the latest reviewer round comment has an incorrect first line'
		same=no
		case $head in "$commit"*) same=yes ;; esac
		last=no
		if [ "$review_at" -gt 0 ] && [ "$verdict" != lgtm ] && [ "$round" -ge "$max_rounds" ]; then
			last=yes
		fi
		if [ "$state" != OPEN ]; then
			code=11 text="event=closed state=$state"
		elif [ "$role" = review ]; then
			if [ "$review_at" -eq 0 ]; then
				code=0 text="event=review reason=first round=1 head=$head"
			elif [ "$verdict" = lgtm ] && [ "$same" = yes ]; then
				code=10 text="event=done round=$round head=$head"
			elif [ "$last" = yes ]; then
				code=14 text="event=limit round=$round head=$head"
			elif [ "$fix_at" -gt "$review_at" ]; then
				code=0 text="event=review reason=ready round=$((round + 1)) head=$head previous=$commit"
			elif [ "$same" = no ]; then
				if [ "$head" != "$seen_head" ]; then
					seen_head=$head
					seen_at=$now
				fi
				if [ $((now - seen_at)) -ge "$settle" ]; then
					code=0 text="event=review reason=commits round=$((round + 1)) head=$head previous=$commit"
				fi
			fi
		elif [ "$review_at" -gt "$fix_at" ]; then
			if [ "$verdict" = lgtm ]; then
				code=10 text="event=done round=$round head=$head"
			else
				code=0 text="event=fix round=$round head=$head author=$author"
			fi
		elif [ "$last" = yes ]; then
			code=14 text="event=limit round=$round head=$head"
		fi
	else
		failures=$((failures + 1))
		[ "$failures" -lt 5 ] || fail 'gh pr view failed 5 times; examine the PR reference and gh auth status'
	fi

	case $code in 10 | 11 | 14) finish "$code" "$text" ;; esac
	[ "$now" -lt "$deadline" ] || finish 12 'event=timeout'
	[ "$code" != 0 ] || finish 0 "$text"
	[ "$now" -lt "$slice_end" ] || finish 13 'event=waiting'

	pause=$interval
	[ $((deadline - now)) -ge "$pause" ] || pause=$((deadline - now))
	[ $((slice_end - now)) -ge "$pause" ] || pause=$((slice_end - now))
	[ "$pause" -ge 1 ] || pause=1
	sleep "$pause"
done
