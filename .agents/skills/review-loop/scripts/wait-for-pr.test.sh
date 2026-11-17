#!/bin/sh
# Fixture checks for wait-for-pr.sh. A stub gh command applies the --jq filter of the
# script to a synthetic PR. The checks need jq and no network access.
set -u

script=$(cd "$(dirname "$0")" && pwd)/wait-for-pr.sh
command -v jq >/dev/null || {
	echo 'wait-for-pr.test: jq is necessary for these checks' >&2
	exit 2
}
work=$(mktemp -d) || exit 2
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat >"$work/bin/gh" <<'EOF'
#!/bin/sh
# gh api user --jq .login
if [ "$1" = api ]; then
	echo tester
	exit 0
fi
# gh pr view PR --json FIELDS --jq FILTER
[ -z "${GH_FAIL:-}" ] || exit 1
jq -r "$7" "$FIXTURE"
EOF
chmod +x "$work/bin/gh"

A=aaaaaaa1111111111111111111111111111111aa
B=bbbbbbb2222222222222222222222222222222bb
C=ccccccc3333333333333333333333333333333cc
passed=0
failed=0

# fixture STATE HEAD [AUTHOR|TIME|BODY]...
fixture() {
	state=$1
	head=$2
	shift 2
	comments='[]'
	for comment in "$@"; do
		author=${comment%%|*}
		rest=${comment#*|}
		time=${rest%%|*}
		body=$(printf '%b' "${rest#*|}")
		comments=$(printf '%s' "$comments" | jq --arg a "$author" --arg t "$time" --arg b "$body" \
			'. + [{author: {login: $a}, createdAt: $t, body: $b}]')
	done
	jq -n --arg s "$state" --arg h "$head" --argjson c "$comments" \
		'{state: $s, headRefOid: $h, comments: $c}' >"$work/fixture.json"
}

# check NAME STATUS TEXT ROLE [OPTION]...
check() {
	name=$1
	want_status=$2
	want_text=$3
	role=$4
	shift 4
	# Each check gets an empty TMPDIR, unless SHARED names one for several calls.
	temporary=${SHARED:-$(mktemp -d "$work/tmp.XXXXXX")}
	output=$(FIXTURE=$work/fixture.json PATH=$work/bin:$PATH TMPDIR=$temporary ${TEST_SHELL:-sh} "$script" "$role" 32 "$@" --interval 1 2>&1)
	status=$?
	case $output in *"$want_text"*) found=yes ;; *) found=no ;; esac
	if [ "$status" = "$want_status" ] && [ "$found" = yes ]; then
		passed=$((passed + 1))
	else
		failed=$((failed + 1))
		printf 'FAIL %s: want status %s and "%s", got status %s and "%s"\n' \
			"$name" "$want_status" "$want_text" "$status" "$(printf '%s\n' "$output" | head -n 1)"
	fi
}

# The deadline is 60 seconds from now, or the given number of seconds.
soon() {
	echo $(($(date +%s) + ${1:-60}))
}

review1="tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: CHANGES REQUESTED**\nTool: Claude Code. Model: Claude Opus 5.5. Reasoning effort: unknown.\n\n## Blocking\n- R1-1"
reply1="tester|2026-01-01T00:00:02Z|**[review-loop implementer] round 1, commit $B: READY**\nTool: Codex. Model: GPT-6.1 Sol. Reasoning effort: Extra High.\n\n- R1-1 fixed"
reply1_old="tester|2026-01-01T00:00:02Z|**[review-loop implementer] round 1, commit $A: READY**\nTool: Codex. Model: GPT-6."
lgtm2="tester|2026-01-01T00:00:03Z|**[review-loop reviewer] round 2, commit $B: LGTM**\nTool: Claude Code. Model: Claude Opus 5.5. Reasoning effort: unknown.\n\nLGTM."
review2="tester|2026-01-01T00:00:03Z|**[review-loop reviewer] round 2, commit $A: CHANGES REQUESTED**"
review5="tester|2026-01-01T00:00:09Z|**[review-loop reviewer] round 5, commit $A: CHANGES REQUESTED**"
reply5="tester|2026-01-01T00:00:10Z|**[review-loop implementer] round 5, commit $B: READY**"
lgtm5="tester|2026-01-01T00:00:09Z|**[review-loop reviewer] round 5, commit $A: LGTM**"

fixture OPEN $A
check 'review without a round comment' 0 "event=review reason=first round=1 head=$A" review --until "$(soon)"
check 'fix without a review, deadline' 12 'event=timeout' fix --until "$(soon 2)"
check 'fix without a review, slice' 13 'event=waiting' fix --until "$(soon)" --slice 1

fixture OPEN $A "$review1"
check 'fix after a review' 0 "event=fix round=1 head=$A author=tester" fix --until "$(soon)"
check 'review waits for the fix' 13 'event=waiting' review --until "$(soon)" --slice 1
check 'deadline before the fix' 12 'event=timeout' fix --until "$(soon 0)"

fixture OPEN $B "$review1" "$reply1"
check 'review after READY' 0 "event=review reason=ready round=2 head=$B previous=$A" review --until "$(soon)"
check 'fix waits for the review' 13 'event=waiting' fix --until "$(soon)" --slice 1

fixture OPEN $A "$review1" "$reply1_old"
check 'review after a reply without a commit' 0 "event=review reason=ready round=2 head=$A" review --until "$(soon)"

# A READY comment for an earlier commit does not start a review immediately.
fixture OPEN $B "$review1" "$reply1_old"
check 'READY for an earlier commit waits' 12 'event=timeout' review --until "$(soon 2)" --settle 30
check 'READY for an earlier commit, settled' 0 "event=review reason=ready round=2 head=$B" review --until "$(soon)" --settle 2

fixture OPEN $B "$review1"
check 'review after settled commits' 0 "event=review reason=commits round=2 head=$B previous=$A" review --until "$(soon)" --settle 2
check 'commits not settled before the deadline' 12 'event=timeout' review --until "$(soon 2)" --settle 30
check 'commits not settled in the slice' 13 'event=waiting' review --until "$(soon)" --settle 30 --slice 1

# The next call with the same deadline continues the observation of the head commit.
# Without the saved observation, the second call ends with event=waiting.
SHARED=$(mktemp -d "$work/shared.XXXXXX")
deadline=$(soon)
check 'observation, first call' 13 'event=waiting' review --until "$deadline" --settle 4 --slice 2
check 'observation, next call' 0 'event=review reason=commits round=2' review --until "$deadline" --settle 4 --slice 3
# A new head commit starts a new observation.
fixture OPEN $C "$review1"
check 'observation of a new head' 13 'event=waiting' review --until "$deadline" --settle 4 --slice 2
unset SHARED

# The observation is private to the user. Find its folder from the key of the script.
folder_of() {
	printf '%s/review-loop-%s' "$1" "$(printf '%s-%s-%s-%s' 32 review tester "$2" | tr -c 'A-Za-z0-9-' '_')"
}
expect() {
	if eval "$2"; then
		passed=$((passed + 1))
	else
		failed=$((failed + 1))
		printf 'FAIL %s\n' "$1"
	fi
}
fixture OPEN $B "$review1"
SHARED=$(mktemp -d "$work/shared.XXXXXX")
deadline=$(soon)
folder=$(folder_of "$SHARED" "$deadline")
check 'observation, private folder' 13 'event=waiting' review --until "$deadline" --settle 30 --slice 1
expect 'the folder has mode 700' '[ "$(ls -ld "$folder" | cut -c1-10)" = drwx------ ]'
expect 'the record is complete' 'read -r h t <"$folder/observation" && [ "$h" = $B ] && [ -n "$t" ]'
# An incomplete record does not start a review immediately.
printf '%s\n' $B >"$folder/observation"
check 'observation, record without a time' 13 'event=waiting' review --until "$deadline" --settle 30 --slice 1
printf '%s 12a\n' $B >"$folder/observation"
check 'observation, time that is not decimal' 13 'event=waiting' review --until "$deadline" --settle 30 --slice 1
printf 'bbbbbbb %s\n' 1 >"$folder/observation"
check 'observation, short commit ID' 13 'event=waiting' review --until "$deadline" --settle 30 --slice 1
unset SHARED

# A symbolic link at the folder path does not get the record.
SHARED=$(mktemp -d "$work/shared.XXXXXX")
deadline=$(soon)
printf 'keep\n' >"$work/target"
ln -s "$work/target" "$(folder_of "$SHARED" "$deadline")"
check 'observation, symbolic link' 13 'event=waiting' review --until "$deadline" --settle 30 --slice 1
expect 'nothing written through the link' '[ "$(cat "$work/target")" = keep ]'
unset SHARED

# The observation ends when the head returns to the reviewed commit. Without this, the
# third call starts a review with the first observation of B.
SHARED=$(mktemp -d "$work/shared.XXXXXX")
deadline=$(soon)
fixture OPEN $B "$review1"
check 'return to the reviewed commit, first call' 13 'event=waiting' review --until "$deadline" --settle 4 --slice 2
fixture OPEN $A "$review1"
check 'return to the reviewed commit, second call' 13 'event=waiting' review --until "$deadline" --settle 4 --slice 1
fixture OPEN $B "$review1"
check 'return to the reviewed commit, third call' 13 'event=waiting' review --until "$deadline" --settle 4 --slice 2
unset SHARED

fixture OPEN $B "$review1" "$reply1" "$lgtm2"
check 'review done' 10 'event=done round=2' review --until "$(soon)"
check 'fix done' 10 'event=done round=2' fix --until "$(soon)"
check 'done after the deadline' 10 'event=done' fix --until "$(soon 0)"

fixture OPEN $B "$lgtm2" "$reply1" "$review1"
check 'comments sorted by time' 10 'event=done round=2' fix --until "$(soon)"

# An LGTM for an earlier commit does not end the loop for one role only.
fixture OPEN $B "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: LGTM**"
check 'fix waits after LGTM for an earlier commit' 13 'event=waiting' fix --until "$(soon)" --slice 1
check 'review after LGTM for an earlier commit' 0 'event=review reason=commits round=2' review --until "$(soon)" --settle 1

# A READY comment answers only the review that has the same round number.
fixture OPEN $A "$review1" "$review2" "tester|2026-01-01T00:00:04Z|**[review-loop implementer] round 1, commit $A: READY**"
check 'late READY does not start a review' 13 'event=waiting' review --until "$(soon)" --slice 1
check 'late READY does not answer the new round' 0 'event=fix round=2' fix --until "$(soon)"

# A READY comment answers only a review that comes before it.
fixture OPEN $A "$review1" "tester|2026-01-01T00:00:02Z|**[review-loop implementer] round 2, commit $A: READY**" "$review2"
check 'early READY does not start a review' 13 'event=waiting' review --until "$(soon)" --slice 1
check 'early READY does not answer the review' 0 'event=fix round=2' fix --until "$(soon)"

fixture MERGED $B "$review1"
check 'merged' 11 'event=closed state=MERGED' fix --until "$(soon)"

# The two roles stop together at the round limit.
fixture OPEN $A "$review5"
check 'review limit' 14 'event=limit round=5' review --until "$(soon)"
check 'fix limit' 14 'event=limit round=5' fix --until "$(soon)"
check 'larger limit, review' 13 'event=waiting' review --until "$(soon)" --max-rounds 6 --slice 1
check 'larger limit, fix' 0 'event=fix round=5' fix --until "$(soon)" --max-rounds 6

fixture OPEN $B "$review5" "$reply5"
check 'fix limit after READY' 14 'event=limit round=5' fix --until "$(soon)"

fixture OPEN $B "$lgtm5"
check 'review limit after LGTM for an earlier commit' 14 'event=limit round=5' review --until "$(soon)" --settle 1
check 'fix limit after LGTM for an earlier commit' 14 'event=limit round=5' fix --until "$(soon)"

fixture OPEN $A "other|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: LGTM**"
check 'other account ignored' 0 'event=review reason=first' review --until "$(soon)"
check 'selected account' 10 'event=done' review --until "$(soon)" --author other

fixture OPEN $A "tester|2026-01-01T00:00:01Z|A quotation:\n**[review-loop reviewer] round 1, commit $A: LGTM**"
check 'first line only' 0 'event=review reason=first' review --until "$(soon)"

fixture OPEN $A "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: CHANGES REQUESTED**\r\nBody"
check 'CRLF line end' 0 'event=fix round=1' fix --until "$(soon)"

# The first line must have the complete format.
bad='reviewer role has an incorrect first line'
fixture OPEN $A 'tester|2026-01-01T00:00:01Z|**[review-loop reviewer] LGTM**'
check 'reviewer line without round and commit' 2 "$bad" review --until "$(soon)"
fixture OPEN $A "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: NOT LGTM**"
check 'reviewer line with an unknown result' 2 "$bad" fix --until "$(soon)"
fixture OPEN $A 'tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit aaaaaaa1: LGTM**'
check 'reviewer line with a short commit ID' 2 "$bad" review --until "$(soon)"
fixture OPEN $A "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: LGTM** and more"
check 'reviewer line with more text' 2 "$bad" review --until "$(soon)"
fixture OPEN $A "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: LGTM**\tand more"
check 'reviewer line with text after a tab' 2 "$bad" review --until "$(soon)"
fixture OPEN $A "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 0, commit $A: CHANGES REQUESTED**"
check 'reviewer line with round 0' 2 "$bad" review --until "$(soon)"
fixture OPEN $A "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 01, commit $A: CHANGES REQUESTED**"
check 'reviewer line with a leading zero' 2 "$bad" review --until "$(soon)"
fixture OPEN $A "$review1" "tester|2026-01-01T00:00:02Z|**[review-loop implementer] round 1, commit $A: READY**\tand more"
check 'implementer line with text after a tab' 2 'implementer role has an incorrect first line' review --until "$(soon)"
fixture OPEN $A "$review1" 'tester|2026-01-01T00:00:02Z|**[review-loop implementer] round 1**'
check 'implementer line without commit and result' 2 'implementer role has an incorrect first line' review --until "$(soon)"
fixture OPEN $A "$review1" 'tester|2026-01-01T00:00:02Z|**[review-loop helper] round 1**'
check 'unknown role' 2 'unknown role has an incorrect first line' fix --until "$(soon)"
fixture OPEN $A 'tester|2026-01-01T00:00:00Z|**[review-loop reviewer] LGTM**' "$review1"
check 'corrected reviewer line' 0 'event=fix round=1' fix --until "$(soon)"
fixture OPEN $A 'tester|2026-01-01T00:00:00Z|**[review-loop reviwer] round 1**' "tester|2026-01-01T00:00:01Z|**[review-loop reviewer] round 1, commit $A: LGTM**"
check 'corrected unknown role' 10 'event=done round=1' fix --until "$(soon)"

# A closed PR ends the loop also when a first line is incorrect.
fixture CLOSED $A 'tester|2026-01-01T00:00:01Z|**[review-loop reviewer] LGTM**'
check 'closed with an incorrect first line' 11 'event=closed state=CLOSED' review --until "$(soon)"

fixture OPEN $A
check 'no deadline' 2 'Usage' review
check 'incorrect role argument' 2 'Usage' watch --until 5
GH_FAIL=1
export GH_FAIL
check 'gh failure, then deadline' 12 'event=timeout' review --until "$(soon 2)"
check 'gh failure 5 times' 2 'failed 5 times' review --until "$(soon)"
unset GH_FAIL

printf 'wait-for-pr.test: %s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
