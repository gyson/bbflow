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
  --slice SECONDS     The usual longest time that one call waits. A call that
                      observes a new head commit continues for the settle time
                      at most. 0 waits until the deadline. Default: 360.
  --interval SECONDS  The time between two checks. Default: 60.
  --settle SECONDS    review only. Without a READY comment for the head commit,
                      a review starts after the head commit stays the same for
                      this time. Default: 180.
  --max-rounds N      The largest number of review rounds. Default: 5.
  --author LOGIN      The account that posts the round comments. Default: the
                      account of the gh command.

Exit status:
   0  event=review or event=fix. Do the next round.
  10  event=done. The reviewer posted LGTM for the head commit.
  11  event=closed. The PR is merged or closed.
  12  event=timeout. The deadline passed.
  13  event=waiting. The slice ended. Run the same command again.
  14  event=limit. All review rounds ended without LGTM for the head commit.
   2  Incorrect arguments, a gh failure, or a round comment with an incorrect
      first line.
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
slice=360
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

# Print: state, head commit, round and commit and verdict of the latest review, the
# commit of the READY comment that answers this review, and the kind of a round comment
# with an incorrect first line. A round of 0 means that no review exists. A READY
# comment answers a review when it has the same round number and comes after it.
snapshot() {
	raw=$(gh pr view "$pr" --json state,headRefOid,comments --jq "$filter") || return 1
	printf '%s\n' "$raw" | awk -F '\t' '
		function part(line, pattern, skip) {
			return match(line, pattern) ? substr(line, RSTART + skip, RLENGTH - skip) : ""
		}
		function first(role, result) {
			return "**[review-loop " role "] round " number ", commit " id ": " result "**"
		}
		$1 == "state" { state = $2 }
		$1 == "head" { head = $2 }
		$1 == "mark" {
			number = part($2, "round [0-9]+", 6)
			id = part($2, "commit [0-9a-f]+", 7)
			if (length(id) != 40) number = ""
			if (index($2, "**[review-loop reviewer] ") == 1) {
				result = ""
				if (number != "" && $2 == first("reviewer", "LGTM")) result = "lgtm"
				if (number != "" && $2 == first("reviewer", "CHANGES REQUESTED")) result = "changes"
				badReview = (result == "")
				if (!badReview) { round = number + 0; commit = id; verdict = result; answer = "-" }
			} else if (index($2, "**[review-loop implementer] ") == 1) {
				badReply = (number == "" || $2 != first("implementer", "READY"))
				if (!badReply && number + 0 == round) answer = id
			} else {
				badRole = 1
			}
		}
		END {
			if (state == "" || head == "") exit 1
			bad = badReview ? "reviewer" : badReply ? "implementer" : badRole ? "unknown" : "-"
			if (!round) { round = 0; commit = "-"; verdict = "-"; answer = "-" }
			print state, head, round, commit, verdict, answer, bad
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
	observing=no
	if line=$(snapshot); then
		failures=0
		# shellcheck disable=SC2086
		set -- $line
		state=$1 head=$2 round=$3 commit=$4 verdict=$5 answer=$6 bad=$7
		[ "$bad" = - ] || fail "the latest round comment of the $bad role has an incorrect first line"
		if [ "$state" != OPEN ]; then
			code=11 text="event=closed state=$state"
		elif [ "$round" -eq 0 ]; then
			[ "$role" != review ] || code=0 text="event=review reason=first round=1 head=$head"
		elif [ "$verdict" = lgtm ] && [ "$commit" = "$head" ]; then
			code=10 text="event=done round=$round head=$head"
		elif [ "$round" -ge "$max_rounds" ]; then
			code=14 text="event=limit round=$round head=$head"
		elif [ "$role" = fix ]; then
			if [ "$verdict" = changes ] && [ "$answer" = - ]; then
				code=0 text="event=fix round=$round head=$head author=$author"
			fi
		elif [ "$answer" = "$head" ]; then
			code=0 text="event=review reason=ready round=$((round + 1)) head=$head previous=$commit"
		elif [ "$answer" != - ] || [ "$commit" != "$head" ]; then
			# No READY comment names the head commit. Start only after the head commit
			# stops changing.
			if [ "$head" != "$seen_head" ]; then
				seen_head=$head
				seen_at=$now
			fi
			if [ $((now - seen_at)) -ge "$settle" ]; then
				reason=commits
				[ "$answer" = - ] || reason=ready
				code=0 text="event=review reason=$reason round=$((round + 1)) head=$head previous=$commit"
			else
				observing=yes
			fi
		fi
	else
		failures=$((failures + 1))
		[ "$failures" -lt 5 ] || fail 'gh pr view failed 5 times; examine the PR reference and gh auth status'
	fi

	case $code in 10 | 11 | 14) finish "$code" "$text" ;; esac
	[ "$now" -lt "$deadline" ] || finish 12 'event=timeout'
	[ "$code" != 0 ] || finish 0 "$text"
	# Do not discard an observation of the head commit at the end of the slice.
	stop_at=$slice_end
	[ "$observing" = no ] || stop_at=$((slice_end + settle))
	[ "$now" -lt "$stop_at" ] || finish 13 'event=waiting'

	pause=$interval
	[ $((deadline - now)) -ge "$pause" ] || pause=$((deadline - now))
	[ $((stop_at - now)) -ge "$pause" ] || pause=$((stop_at - now))
	[ "$pause" -ge 1 ] || pause=1
	sleep "$pause"
done
