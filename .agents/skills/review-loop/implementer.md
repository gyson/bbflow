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

2. Run the wait script with `fix`. See [SKILL.md](SKILL.md#wait-for-the-other-role).
3. On `event=fix`, do a fix round. Use `round` and `author` from the output.
4. After you post the round comment, go to step 2.
5. Stop on the other events. See the [stop rules](SKILL.md#stop-rules).

## Fix round

1. Read the latest reviewer round comment. Replace `AUTHOR` with the `author` value.

   ```sh
   gh pr view PR --json comments --jq '[.comments[] | select(.author.login == "AUTHOR") | select(.body | startswith("**[review-loop reviewer]"))] | last | .body'
   ```

2. If a finding has the mark **Decision needed**, stop and ask the user.
3. Make a decision for each blocking, non-blocking, and open finding.
   - **Fix** it when the finding is correct.
   - **Decline** it when it is incorrect, out of scope, or against a decision of the
     user or a rule in `AGENTS.md`. Give the technical reason.
4. Make the changes. Add or update tests and owner documents as `AGENTS.md` requires.
5. Run the checks that apply to the change. Correct each failure before you continue.
6. Commit and push. Confirm that the remote head is equal to `git rev-parse HEAD`.

   ```sh
   gh pr view PR --json headRefOid --jq .headRefOid
   ```

7. Review the full diff against the target branch. If the behavior, scope, design, or
   validation changed, update the PR title and body. Follow the rules for reviewable
   pull requests in `AGENTS.md`.
8. Post the round comment. Post it also when you declined all findings and pushed
   nothing. The reviewer waits for it.

## Round comment

Answer each finding by its ID. Use the round number of the review that you answer.

```markdown
**[review-loop implementer] round 2, commit 89abcdef0123456789abcdef0123456789abcdef: READY**

- **R2-1** fixed in 89abcde: <what changed>.
- **R2-2** declined: <the technical reason>.
- **R1-2** fixed in 4567abc: <what changed>.

## Checks

- `make test`: passed.
- `make web-check`: passed.
```
