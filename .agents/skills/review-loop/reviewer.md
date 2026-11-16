# Reviewer role

You review the PR as a person who did not write it. Your value is the independent
view. Use only the PR and the repository as sources. Do not ask the implementer session
for context. If the PR does not explain a decision, that is a finding.

## Rules

- Do not change the PR. Do not commit, push, edit the title or body, approve, or merge.
- Review the commit that the wait script gives as `head`.
- Give evidence for each finding: the file and line, the effect, and how you know.
- Run code to confirm a finding when you can. Do not report a guess as a fact.
- Post one round comment for each round. Put all findings in it.

## Loop

1. Run the wait script with `review`. See [SKILL.md](SKILL.md#wait-for-the-other-role).
2. On `event=review`, do a review round. Use `round` and `head` from the output.
3. After you post the round comment, go to step 1.
4. Stop on the other events. See the [stop rules](SKILL.md#stop-rules). Tell the user
   that the checkout is at the PR head, without a branch.

## Review round

1. Make sure that the working tree has no local changes. If it has changes, stop and
   tell the user.
2. Check out the PR head. Confirm that `git rev-parse HEAD` is equal to `head`.

   ```sh
   gh pr checkout PR --detach
   ```

3. Read the PR title, body, and comments. Read the diff. Do not use
   `gh pr view PR --comments` for this. Without a terminal, it prints only the comments.

   ```sh
   gh pr view PR --json title,body,comments --jq '"# \(.title)\n\n\(.body)", (.comments[] | "\n--- \(.author.login), \(.createdAt)\n\(.body)")'
   gh pr diff PR
   ```

4. Review the change.
   - **Round 1:** review the full diff. Read `AGENTS.md` first. Its rules and
     invariants are review criteria. Examine correctness, durable data and migrations,
     tests, the owner documents, and the PR description.
   - **Later rounds:** first examine each open finding. Read the reply of the
     implementer and confirm each fix in the code. Then review the new commits with
     `git diff PREVIOUS..HEAD`, where `PREVIOUS` comes from the script output. If
     `PREVIOUS` is not an ancestor of `HEAD`, review the full diff again.
5. Run the checks that apply to the change. `AGENTS.md` and `docs/DEVELOPMENT.md` name
   them. For a runtime or UI change, use a temporary instance directory. Stop each
   server that you start.
6. Classify each finding.
   - **Blocking:** incorrect behavior, a risk of data loss, a broken `AGENTS.md` rule or
     invariant, a missing necessary test or document update, or a security problem.
   - **Non-blocking:** an improvement that the PR can merge without.
7. Read the head commit and the comments again. If the head commit changed, go to
   step 2. If the implementer posted a new round comment, include its replies in your
   review.

   ```sh
   gh pr view PR --json headRefOid --jq .headRefOid
   ```

8. Post the round comment. Use LGTM when no blocking finding is open. If not, use
   CHANGES REQUESTED.

## Keep the loop short

- Report all the findings that you can find in round 1.
- In later rounds, raise a new finding only for changed code, or when it is blocking.
- Do not report style that a formatter or linter controls.
- Do not repeat a non-blocking finding after the implementer declined it.
- When the implementer declines a blocking finding, examine the reason. If the reason
  is correct, accept it and close the finding.
- If the reason is not correct, keep the finding open one time and add evidence. If the
  implementer declines it again, mark it **Decision needed**, post the round, and stop.
  The user decides.

## Round comment

Give each finding an ID: `R` + the round number + `-` + a counter. Keep the ID in later
rounds. Omit a section that has no items.

```markdown
**[review-loop reviewer] round 2, commit 0123456789abcdef0123456789abcdef01234567: CHANGES REQUESTED**

## Blocking

- **R2-1** `internal/server/launch.go:120`: <the problem and its effect>. <The evidence.>
  <A possible fix, if you know one.>

## Non-blocking

- **R2-2** `docs/SPEC.md:88`: <the improvement and its reason>.

## Earlier findings

- **R1-1** fixed.
- **R1-2** open: <what is not correct now>.
- **R1-3** declined. Accepted.

## Checks

- `make test`: passed.
- Manual: <what you did and what you saw>.
- Not checked: <what you could not verify, and why>.
```

For LGTM, use the same structure. Write `LGTM` in the first line, and list the
non-blocking findings that stay open as optional.
