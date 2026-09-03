# omp-extensions

[`toxicwind/omp-extensions`](https://github.com/toxicwind/omp-extensions) — a monorepo of oh-my-pi (`omp`) extensions.

A curated set of `omp` extensions that plug directly into your oh-my-pi agent session. Two extensions ship out of the box:

- **omp-kafka** — subscribe to Apache Kafka topics and surface messages in the session (auto push or on-demand pull).
- **omp-edit-committer** — auto-commit every Edit/Write with a descriptive Conventional-Commits message and surface the SHA under the tool result.

```mermaid
flowchart LR
    subgraph omp[omp session]
        ext1[omp-kafka]
        ext2[omp-edit-committer]
    end
    Kafka((Kafka)) --> ext1
    Agent --> ext1
    Agent --> ext2
    Git[(Git)] --> ext2
end
```

## Extensions

| Extension | Category | What it does |
|---|---|---|
| [`omp-kafka`](packages/omp-kafka) | Integration | Consume Kafka topics into an `omp` session; supports auto (push) and pull modes with `/kafka-*` slash commands and a `kafka_consume` LLM tool. |
| [`omp-edit-committer`](packages/omp-edit-committer) | Workflow | Auto-commit every Edit/Write with intent, trade-offs, and an ASCII diagram; renders a commit badge next to the tool result for use with `modem-dev/hunk`. |

## Install

Requires `omp >= 17.0.0`.

### Option A — clone the monorepo and link

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/toxicwind/omp-extensions ~/.omp/agent/extensions/omp-extensions
cd ~/.omp/agent/extensions/omp-extensions
git sparse-checkout set packages/omp-kafka
cd packages/omp-kafka
bun install
omp plugin link .
```

The whole monorepo can be cloned if you want both extensions — drop `--filter=blob:none --sparse` and the `sparse-checkout` lines.

### Option B — install via npm (once published)

```bash
bun add -g @toxicwind/omp-kafka
bun add -g @toxicwind/omp-edit-committer
```

Then add to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - @toxicwind/omp-kafka
  - @toxicwind/omp-edit-committer
```

### Option C — load once for a single session

```bash
omp --extension /path/to/omp-extensions/packages/omp-kafka
omp --extension /path/to/omp-extensions/packages/omp-edit-committer
```

## Development

```bash
bun install
bun run --workspaces test
bun run --workspaces typecheck
```

All packages typecheck and test cleanly. `node_modules/` stays minimal — only declared dependencies, no transitive junk.

## License

MIT — see [LICENSE](./LICENSE).
