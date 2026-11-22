# Implementer role

You wrote the change and you have its context. You answer each review round. Fix the
findings that are correct. Decline the others with a reason.

## Rules

- This role commits, pushes to the PR branch, posts round comments, and updates the PR
  title and body. The user's request for this role permits these actions for this PR.
  Do not ask again for each round.
- Do nothing more. Do not merge, approve, close, or push to a different branch.
- Add new commits. Do not amend, rebase, or push with `--force` during the loop. The
  reviewer reads the difference between rounds.
- A finding is technical input, not an order. Confirm it in the code before you act.
- If a finding needs a product decision or a large change of scope, stop and ask the
  user.

## Loop

1. Make sure that the current branch is the PR branch.

   ```sh
   gh pr view PR --json headRefName --jq .headRefName
   git branch --show-current
   ```

2. Run the copy of the wait script with `fix`. See
   [SKILL.md](SKILL.md#wait-for-the-other-role).
3. On `event=fix`, do a fix round. Use `round` and `author` from the output.
4. After you post the round comment, go to step 2.
5. Stop on the other events. See the [stop rules](SKILL.md#stop-rules).

## Fix round

1. Read the latest reviewer round comment. Replace `AUTHOR` with the `author` value.

   ```sh
   gh pr view PR --json comments --jq '[.comments[] | select(.author.login == "AUTHOR") | select(.body | startswith("**[review-loop reviewer]"))] | last | .body'
   ```

   Also read the PR comments without a round marker that came after your last round
   comment. The user or another reviewer can post findings there. Answer them in your
   next round comment.

2. If a finding has the mark **Decision needed**, stop and ask the user.
3. Make a decision for each new finding and each open earlier finding. Each finding is
   a request for a change. Do not skip a finding.
   - **Fix** it when the finding is correct.
   - **Decline** it when it is incorrect, out of scope, or against a decision of the
     user or a rule in `AGENTS.md`. Give the technical reason.
4. Make the changes. Add or update tests and owner documents as `AGENTS.md` requires.
5. Run the checks that apply to the change. Correct each failure before you continue.
6. If you made changes, commit them. Do not push at this time.
7. Read the published PR title and body. Compare them with the full diff against the
   target branch in every round, including rounds with no new commits. Correct stale
   text. If you have a commit to push, publish the corrected text first. Follow the
   rules for reviewable pull requests in `AGENTS.md`.
8. Write the round comment in a file. Use the ID of the local head commit.
9. If you made a commit, push it. Confirm that the remote head is equal to
   `git rev-parse HEAD`. GitHub can show the earlier head for some seconds. If the heads
   differ, wait 10 seconds and read again, a maximum of 5 times.

   ```sh
   gh pr view PR --json headRefOid,title,body
   ```

10. Verify that the published title and body describe the full change at the confirmed
    head. Correct any discrepancy and verify the published text again before READY.
11. Post the round comment as soon as these checks pass, even if you pushed nothing.
    Three minutes after a push, the reviewer can start without your replies.

## Round comment

Answer each finding by its ID. Use the round number of the latest review, also when it
is LGTM and you answer other comments. The wait script accepts the comment only as the
answer to the review with this number. Follow the shared
[round comment rules](SKILL.md#round-comments) for the second line.

```markdown
**[review-loop implementer] round 2, commit 89abcdef0123456789abcdef0123456789abcdef: READY**
Tool: <tool>. Model: <full model name or ID>. Reasoning effort: <effort>.

- **R2-1** fixed in 89abcde: <what changed>.
- **R2-2** declined: <the technical reason>.
- **R1-2** fixed in 4567abc: <what changed>.

## Checks

- `make test`: passed.
- `make web-check`: passed.
```
