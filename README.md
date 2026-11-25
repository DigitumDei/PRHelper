# PR Flow

A VS Code extension for reviewing pull requests by flow, not just by diff.

A diff shows what changed. PR Flow shows where each change sits in the call flow:
what reaches the changed function, what it reaches, and which of those calls the
PR added, changed or removed.

## How it works

Open the **PR Flow** tab in the bottom panel. It has two views.

**Changed in this PR** lists the changed files, and under each file the functions
the PR touches. Click a function to open its diff and centre the flow on it.

**Flow** shows three columns for the function your cursor is in:

| Column | Shows |
| --- | --- |
| Flows from | Functions that call this one |
| You are here | The function, and whether the PR added or changed it |
| Flows to | Functions this one calls, in the order it reaches them |

Lines between them are coloured by what the PR did to that call: green for a new
call, amber for a call whose line was edited or moved, dashed red for a call that
was removed, grey for unchanged. A coloured stripe on a card means that function
is itself new or changed in the PR.

Click any card to go to that function. The flow re-centres on it, so you can keep
walking. On code the PR did not touch this is plain navigation; on code it did
touch you get the same marked-up view one step further along. **Back** and the
trail at the top retrace your steps.

## Loading changes

- **Open a folder whose branch has an open pull request** and it is picked up
  automatically (needs the `gh` CLI; turn off with `prFlow.detectPullRequest`).
- **PR Flow: Load Pull Request…** lists open pull requests. If the one you pick is
  not the branch you are on:
  - already checked out in a worktree: it offers to open that worktree;
  - not checked out anywhere: it offers to create a worktree for it and open
    that, or to switch this folder's branch instead.
- **PR Flow: Compare with Branch or Ref…** compares the working tree with any ref.
- With no pull request found, it compares against the default branch
  (`origin/HEAD`, then `main` or `master`).

New worktrees go beside the repository's existing worktrees. If it has none, they
go in `prFlow.worktreeDirectory` (default `.worktrees` in the main checkout). The
folder is named after the last part of the branch name. A fresh worktree has no
installed dependencies or build output, so the language server may need those
before its call hierarchy is complete.

The comparison is from the merge-base to the working tree, so uncommitted and
untracked changes are included.

## What it relies on, and where it falls short

Callers and callees come from VS Code's call hierarchy, so any language whose
extension supports "Show Call Hierarchy" works, and nothing else does.

- **Indirect calls are not followed.** Dynamic dispatch, callbacks passed around,
  and anything that goes through a queue or event bus stop at the call that hands
  off. You see `publish(...)`, not who consumes the message.
- **Removed calls are found by reading the removed lines**, not by resolving
  symbols. A removed call can be missed (nested generics) or mislabelled (a call
  inside a string). A removed-call card is only clickable when exactly one
  function of that name exists in the workspace.
- **Function level only.** It shows which functions call which. It does not show
  how branches inside a function changed.
- **One hop at a time.** The panel shows direct callers and callees of the
  function in focus; you walk further by clicking.

## Development

```
npm install
npm test          # unit tests: diff parsing, change classification, real git on a fixture repo
npm run e2e       # opens a throwaway VS Code window and checks the flow against a real language server
```

Press F5 in this folder to run the extension in a development host.

`dev/preview.html` renders the panel with sample data in a browser
(`node dev/serve.js`). `src/e2e` is an end-to-end check that runs inside a real
VS Code against a fixture repo built by `dev/make-fixture.js`.
