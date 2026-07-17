# omp-extensions

Monorepo of [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi) extensions.

Each subdirectory of [`packages/`](./packages) is itself a valid omp extension package — they ship together because they share the same review pipeline, CI, and `tsconfig`, but install independently.

## Extensions

| Package | Description | Install |
|---|---|---|
| [`omp-kafka`](./packages/omp-kafka) | Consume Kafka topics into an omp session in auto (push) or pull mode. | `omp install @rekundzmitry/omp-kafka` |

More extensions will land here as `omp-<name>/` siblings.

## Install

For each extension, see its package README for the full config schema. The short version:

```bash
# Production: from npm
omp install @rekundzmitry/omp-kafka

# Development: from a local clone of this monorepo
git clone https://github.com/RekunDzmitry/omp-extensions
cd omp-extensions/packages/omp-kafka
bun install
omp plugin link .
```

Each package's `package.json#omp.extensions` lists the factory entry points. omp auto-discovers the rest of the directory (`skills/`, `hooks/`, `tools/`, `prompts/`, `mcp.json`, `themes/`).

## Marketplace

A `.omp-plugin/marketplace.json` catalog at the repo root advertises each package:

```bash
omp marketplace add RekunDzmitry/omp-extensions
omp marketplace install omp-kafka@omp-extensions
```

**Note:** Marketplace installs only ship skills, hooks, MCP servers, themes, and prompt templates. Extension factories (`omp.extensions` in `package.json`) are **not** loaded from marketplace installs — they require `omp install <pkg>` or `omp plugin link <dir>`. As of this writing `omp-kafka` is factory-only, so the marketplace catalog exists for future skill/MCP packages.

## Workspace commands

From the repo root:

```bash
bun install            # install every package
bun run typecheck      # tsc -b across all packages
bun run build          # typecheck + emit (publish flow)
bun run test           # bun test across all packages
bun run lint           # biome check
```

Per-package: `cd packages/<name> && bun run typecheck`.

## Repository layout

```
omp-extensions/
├── README.md                  # this file
├── package.json               # bun workspaces root
├── tsconfig.base.json         # shared compiler options
├── tsconfig.json              # project references
├── .github/workflows/ci.yml
├── .omp-plugin/marketplace.json
└── packages/
    ├── omp-kafka/             # @rekundzmitry/omp-kafka
    └── <future extensions>/
```

## Adding a new extension

1. Create `packages/omp-<name>/` with the standard layout (see [`omp-kafka/`](./packages/omp-kafka) for a working example):
   ```
   omp-<name>/
   ├── package.json            # omp.extensions entry, peer-dep on @oh-my-pi/pi-coding-agent
   ├── tsconfig.json           # extends ../../tsconfig.base.json
   ├── README.md
   └── src/extension.ts        # default factory
   ```
2. Add it to `tsconfig.json#references`.
3. Add a row to the extensions table above and an entry in `.omp-plugin/marketplace.json`.
4. Open a PR.

If a second package needs shared code, extract it into `packages/omp-utils/` (private workspace package, not published).

## Migration note

The first extension, `omp-kafka`, lived in its own repo at
[`RekunDzmitry/omp-kafka`](https://github.com/RekunDzmitry/omp-kafka) before
this monorepo was created. That repo is kept for history; new work lands
here. Users who cloned the old repo should re-clone this one.
