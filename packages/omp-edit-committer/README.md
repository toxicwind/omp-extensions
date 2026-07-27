# omp-edit-committer

Part of [`RekunDzmitry/omp-extensions`](https://github.com/RekunDzmitry/omp-extensions) — a monorepo of oh-my-pi (`omp`) extensions.

An [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi) extension that
**commits every Edit and Write** the agent performs, with a descriptive
message, and surfaces the resulting commit SHA directly under the tool
result in the TUI. Designed to be used with
[`modem-dev/hunk`](https://github.com/modem-dev/hunk) for rich diff review.

## What you get

After every successful Edit or Write (subject to the safety rules below)
the agent will have:

1. Created a single git commit on your behalf, with a message that
   contains:
   - a `type(scope): subject` first line (Conventional-Commits-flavored),
   - an **Intent** section: what the change is meant to do,
   - a **Trade-offs** section: what we *didn't* do on purpose,
   - a **Diagram** section: a small ASCII scaffold for complex diffs
     (multi-file, multi-hunk, create/delete/rename),
   - a **Refs** footer with the file list and `+/-/hunks` counts,
   - a `hunk: <sha>` footer that `modem-dev/hunk` can pick up directly.
2. Rendered a small **commit badge** in the TUI, right below the Edit
   tool result. The badge carries the short SHA, the subject, the stat
   line, and a hint to view the commit with `hunk <sha>`.

```
Edit:  src/agent/kafka.rs
────────────────────────────────────────────
   @@ -12,7 +12,9 @@
   -    return old_helper(x);
   +    const y = new_helper(x);
   +    if (!y.ok) throw new Error('nope');
   +    return y.value;
────────────────────────────────────────────
● committed abc1234 via edit (~/repos/foo)
  edit(kafka): swap to failure-aware helper
  +3 / -1 · 1 hunk · 1 file
  view with: hunk abc1234 (primary: src/agent/kafka.rs)
```

## Install

Requires `omp >= 17.0.0` and a working `git` (any modern version).

### Option A — clone the monorepo and link

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/RekunDzmitry/omp-extensions ~/.omp/agent/extensions/omp-extensions
cd ~/.omp/agent/extensions/omp-extensions
git sparse-checkout set packages/omp-edit-committer
cd packages/omp-edit-committer
bun install
omp plugin link .
```

### Option B — install via npm (once published)

```bash
bun add -g @rekundzmitry/omp-edit-committer
```

Then add to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - @rekundzmitry/omp-edit-committer
```

## Commit message format

For an Edit that touches `src/agent/kafka.rs` and adds three lines /
removes one, the committer produces something like:

```text
edit(kafka): swap to failure-aware helper

Intent
- swap to failure-aware helper

Trade-offs
- kept the diff shape minimal; no refactor / no rename / no formatting churn

Refs: src/agent/kafka.rs, +3/-1, 1 hunks
hunk:
```

For a multi-file refactor, the **Diagram** block is added:

```text
refactor(auth): split token validation into a dedicated module

Intent
- split token validation into a dedicated module

Trade-offs
- spans multiple files; reviewer should confirm coupling between sites
- many hunks; consider splitting the commit before review

Diagram
\`\`\`
Edit shape:
  before           after
  ───────          ─────
  src/auth/jwt.ts  ──►  edit (+12/-8)
  src/auth/claims.ts  ──►  edit (+4/-2)
  src/auth/mod.ts  ──►  edit (+1/-1)
\`\`\`

Refs: src/auth/jwt.ts, src/auth/claims.ts, src/auth/mod.ts, +17/-11, 9 hunks
hunk:
```

LLMs can supply a richer intent on the tool call by passing
`intent: "..."` (or `commit_message: "..."`) on the `Edit` / `Write`
input. The committer uses that as the source of the Intent section; if
absent, it falls back to the first added line.

## Safety rules

The committer is conservative. It **no-ops** (silently) when any of the
following is true:

- `cwd` is not inside a git working tree.
- `git config user.name` or `user.email` is unset (so commits would fail
  anyway).
- The Edit/Write tool returned `isError === true` (i.e. the change didn't
  apply).
- The resulting index has no changes (no empty commits; protects against
  writes that don't actually mutate the file).
- `OMP_EDIT_COMMITTER_DISABLED=1` is set in the environment.

When the committer *does* act, it:

- runs `git add -- <paths> <then> git commit --no-verify --no-gpg-sign -m <message>`,
  so any pre-commit hooks in your repo are skipped (they are usually
  tuned for interactive commit messages, not for a firehose of edits),
- never amends, never force-pushes, never rebases,
- never pushes.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `OMP_EDIT_COMMITTER_DISABLED=1` | Disable the extension entirely. |
| `OMP_EDIT_COMMITTER_DEBUG=1` | Log tool-call/result/commit events to stderr. |

## Verification

```bash
bun install
bun run typecheck
bun test
```

## License

MIT — see [LICENSE](./LICENSE).
