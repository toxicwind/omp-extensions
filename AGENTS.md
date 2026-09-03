# AGENTS.md — OMP Extensions (`/home/toxic/projects/sovereign-projects/omp-extensions`)

**Role**: Monorepo of oh-my-pi / tau extensions and plugins.
**Stack**: TypeScript, Bun, OMP plugin architecture.

---

## 🎯 Repository Specifics

- Plugins extend OMP/Tau capabilities, tool definitions, and terminal UI hooks.
- Follow OMP plugin contract and manifests (`package.json`, `.omp-plugin`).

## 🔧 Hard Rules (universal)

1. **Verify live, then claim.** No "done" without `curl` / `lsof` / `nvidia-smi` / `npx tsgo --noEmit`.
2. **Fail loud.** Never `2>/dev/null`, never `|| true`. Errors are diagnostic.
3. **No commit without explicit user request.** Fork stays private under `toxicwind`.
4. **Multi-strategy.** Non-trivial work → 3+ approaches, benchmark, keep runner-up.
5. **TDD/BDD.** Failing assertion first, then fix. `npx tsgo --noEmit` for type-check.
6. **Use emergence tools first.** GHAS (`:25113`) → ast-grep (`ast-grep` binary) → Tombi for TOML.
7. **call_tool_destructive is DEFAULT for state changes.** Write/edit/modify = destructive. Read-only = inspection only.
8. **No `/dev/null`, no banner `echo`.** Both waste tokens.
8b. **BANNED/SLOW TOOLS — do NOT use, ever:** `find`, `head`, `tail`, `/dev/null`, and system-wide `lsof`.
    - `find` over a large/full disk is slow + wasteful -> use `fd` (fast, gitignore-aware)
      or scope `du`/`fd` to a SPECIFIC directory, never the whole `/home`/`/`.
    - `head`/`tail` truncation -> read full files with the `read` tool (1M context).
    - `/dev/null` -> fail loud; never silence errors.
    - `lsof` (esp. system-wide) is INSANELY SLOW -> use INSTANT `/proc/<pid>/fd` symlink
      reads (`readlink /proc/$PID/fd/*`) to see what a process has open. Scope to known PIDs.
9. **Fix bashrc nested quote issue.** The `pi-check` alias had nested double quotes inside single quotes, causing `unexpected EOF while looking for matching '"'` errors. Use functions instead of aliases for complex commands.
9. **CUDA-aware.** RTX 3090 — validate with `nvidia-smi`. Never assume upstream defaults.
10. **Stop stacking long commands.** Sub-second probes. Reserve `60|120` for intentional jobs.
11. **No `head` truncation.** You have 1M context. Read full files. No `| head -20`.
12. **Timeout/failfast/high-frequency is FIRST-CLASS everywhere** (retry, provider-retry, worker-limits, MCP calls, scripts). NO insane monolithic timeouts — use failfast + high-frequency liveness probes + per-attempt deadlines.
13. **Dynamic `${ENV_VAR}` interpolation is first-class** in configs/scripts (settings.json, config.yaml, mcpproxy config, launch scripts). Prefer `${...}` over hardcoded values.
14. **Lint + test after EVERY code change; coverage floor 82%.** Pre-existing type errors in unrelated test files do NOT block the change under review — isolate + report.
15. **BACKGROUNDING IS FIRST-CLASS.** Any op that can run long (downloads, builds, scans,
   npm/pip/apt, model fetches) MUST be launched in background (`cmd &`, capture `$!`), tracked
   by PID, and CANCELLED if it overruns a per-attempt deadline (`timeout`, `kill` on a watchdog
   loop). Never block on a monolithic synchronous command. Keep a live PID ledger.
16. **GOAL = ENDLESS TODO.** TODO.md is a CONTINUOUS improvement loop, not a finite list.
   Re-audit constantly; new findings always append; done items cycle back as deeper waves.
   No "finished" — only "next wave". Mutate TODO after every meaningful step.

---

## 🛠️ Tool Reference

### ✅ INSTALLED (use these)

| Tool | Binary | Purpose |
|---|---|---|
| `fd` | `/usr/bin/fd` | Fast find (respects .gitignore) |
| `rg` | `/usr/bin/rg` | Fast grep (respects .gitignore) |
| `ast-grep` | `~/.local/share/mise/shims/ast-grep` | AST structural search/rewrite |
| `eza` | `/usr/bin/eza` | Modern ls (git-aware) |
| `mise` | `~/.local/bin/mise` | Runtime manager |
| `bun` | mise shim | Fast JS runtime |
| `node` | mise shim | JS runtime |
| `cargo` | mise shim | Rust build |
| `jq` | mise shim | JSON processing |

### ❌ NOT INSTALLED (don't use, install first if needed)

| Tool | Install Command | Purpose |
|---|---|---|
| `tombi` | `mise use -g tombi` | TOML toolkit |
| `tsgo` | `npx tsgo` | TypeScript type-check (use via npx) |
| `vitest` | `npx vitest` | Test runner (use via npx) |

### 🚫 NEVER USE (removed/confusing)

| Name | Why |
|---|---|
| `sg` | That's SGLang, NOT ast-grep. Removed shim. Use `ast-grep`. |

---

## 📝 AST-Grep Patterns

### Rule YAML
```yaml
id: my-rule
language: typescript
rule:
  pattern: 'console.log($MSG)'
fix: 'logger.info($MSG)'
```

### Commands
```bash
ast-grep scan -p 'pattern' -l ts src/
ast-grep scan -p 'pattern' --rewrite 'replacement' src/
ast-grep scan -p 'pattern' --json=stream src/
ast-grep scan -p 'pattern' --interactive src/
ast-grep scan --rule rule.yaml src/
```

---

## 📡 Live-verify commands

```bash
for p in 25100 25109 25112 25115; do
  fuser -s $p/tcp 2>/dev/null && echo "✅ :$p" || echo "❌ :$p DOWN"
done

curl -s http://127.0.0.1:25100/v1/models | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']),'models')"

cd /home/toxic/projects/pi-agent/packages/ai && npx tsgo --noEmit

ast-grep scan -p 'NVIDIA_MODELS' -l ts --json=stream /home/toxic/projects/pi-agent/packages/ai/src/
```

---

## ⏱️ Timeout / Failfast / Dynamic / Env-Var (first-class, 2026-08-13)

- **Failfast + high-frequency**: every retry/timeout path uses per-attempt deadlines, failfast
  on fatal errors, and high-frequency liveness probes. No `timeout 420` monoliths.
- **Dynamic `${ENV_VAR}`**: configs and launch scripts interpolate env vars (`${NVIDIA_API_KEY}`,
  `${HOME}`, etc.). Hardcoded secrets/paths are an anti-pattern — interpolate.
- **Coverage floor 82%**: `npx vitest run --coverage --bail` after code. Lint (`biome`) + typecheck.
- See TODO Wave 5 for the worker-limit `/32` redo + timeout/failfast threading.

## 🔌 MCP / mcpproxy (sovereign-owned)

- **mcpproxy** is the single MCP federation gateway: `http://127.0.0.1:25109/mcp`, owned by
sovereign (`pitchfork start mcpproxy` / `mise run restart-mcpproxy` -> `mcpproxy serve
--config=/home/toxic/.mcpproxy/mcp_config.json`). 43 real upstreams (ghas + 42 others).
- **pi MUST list ONLY `mcpproxy`** in `~/.pi/agent/mcp.json` (no duplicate direct `ghas`/
  `nvidia-nim` entries). All MCP tools reach pi through the proxy via `retrieve_tools`.
- **nvidia-nim is NOT an MCP server.** It is a llama-swap/sovereign-router **completions API**
  (OpenAI-compatible, on `:25100`). NVIDIA models are first-class via pi-agent's `nvidia`
  provider (`packages/ai/src/providers/`) -> sovereign-router/llama-swap, not an MCP upstream.
- **Subagents**: `config.yaml` `can_spawn_subagents:true` + whitelist + `subagents.defaultModel:
  opencode/hy3-free`. The `subagent` spawn tool is a LIVE-PI builtin (not callable from a
  plain assistant context) — fanout only works inside an interactive pi session.

## 🔌 Port SSOT

`/home/toxic/sovereign/config/ports.env` — all 25xxx, never invent.

---
