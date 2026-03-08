# claude-code-gdscript

GDScript language support for [Claude Code](https://claude.ai/code) via Godot's built-in LSP server.

Provides diagnostics, go-to-definition, hover, symbols, and completions for `.gd` files, powered by Godot's native language server.

## How It Works

Godot exposes GDScript LSP over TCP, while Claude Code expects stdio. This plugin provides a per-client bridge that discovers the active project and connects it to a shared Godot backend for that project.

```text
Claude Code client <-> stdio bridge <-> TCP <-> Godot LSP backend
```

In the default `auto` mode, the bridge:

- waits for Claude's `initialize` request so it knows which project is opening
- reuses an existing backend for that project if one is already registered
- otherwise launches a dedicated headless Godot backend on a unique port

That avoids the old single-port `6005` collision problem when you have multiple Godot projects open at once.

## Scope And Installation

Add the marketplace first:

```shell
/plugin marketplace add twaananen/claude-code-gdscript
```

Then install the plugin with an explicit scope.

### Recommended scopes

- `project`: best for Godot repositories where the plugin should be shared with collaborators
- `local`: best when you only want it enabled on your machine for one repository
- `user`: best only if you intentionally want it available across all repositories

### Project scope

```shell
claude plugin install gdscript@claude-code-gdscript --scope project
```

### Local scope

```shell
claude plugin install gdscript@claude-code-gdscript --scope local
```

### User scope

```shell
claude plugin install gdscript@claude-code-gdscript --scope user
```

If most of your repositories are not Godot projects, prefer `project` or `local` scope.

## Prerequisites

- **Godot 4.3+** recommended, because this plugin uses `--lsp-port` when it launches a project-specific backend
- **Godot executable** available on `PATH`, or `GODOT_EDITOR_PATH` set explicitly
- **Node.js** (already required by Claude Code)

If you want to run Godot yourself instead of letting the plugin auto-launch a backend, start it with an explicit LSP port:

```sh
godot --editor --path /path/to/your/project --lsp-port 6005
```

On macOS, the executable is commonly:

```sh
/Applications/Godot.app/Contents/MacOS/Godot
```

## Runtime Modes

### `auto` mode

`auto` is the default and is the recommended mode for multi-project work.

- discovers the project root from the LSP `initialize` request
- launches or reuses one backend per project
- stores backend metadata in a shared registry
- gives each client its own bridge process while reusing the same backend

### `attach` mode

Use this if you want to manage the Godot instance yourself and point the bridge at a specific host and port:

```sh
export GODOT_LSP_MODE=attach
export GODOT_LSP_HOST=127.0.0.1
export GODOT_LSP_PORT=6005
```

`attach` mode is useful if you want Claude to connect to a Godot editor instance that is already running.

## Usage

1. Install the plugin in `project` or `local` scope for your Godot repo.
2. Open Claude Code in the Godot project directory.
3. In default `auto` mode, the bridge launches or reuses a per-project backend automatically.
4. GDScript language features activate for `.gd` files.

### Features

- **Diagnostics**: syntax and type errors surfaced automatically
- **Go-to-definition**: navigate to function and variable declarations
- **Hover**: type info and symbol documentation
- **Document symbols**: outline of functions, variables, and signals
- **Completions**: context-aware code suggestions

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `GODOT_LSP_MODE` | `auto` | `auto` launches or reuses a shared per-project backend. `attach` connects to `GODOT_LSP_HOST:GODOT_LSP_PORT`. |
| `GODOT_EDITOR_PATH` | `godot` | Path to the Godot editor executable used when auto-launching a backend. |
| `GODOT_LSP_REGISTRY_DIR` | `~/.gdscript-lsp` | Shared registry directory for project backends. |
| `GODOT_LSP_HOST` | `127.0.0.1` | Host used in `attach` mode. |
| `GODOT_LSP_PORT` | `6005` | Port used in `attach` mode. |
| `GODOT_PROJECT_ROOT` | unset | Optional project root override if a client cannot provide a normal LSP `initialize` root. |
| `GODOT_LSP_CONNECT_TIMEOUT_MS` | `1000` | TCP connect timeout per attempt. |
| `GODOT_LSP_INITIAL_MAX_ATTEMPTS` | `5` | Initial connect attempts before the bridge exits. |
| `GODOT_LSP_RETRY_DELAY_MS` | `500` | Base exponential backoff delay for initial connect attempts. |

## Multi-Project And Multi-Client Behavior

In `auto` mode, this plugin aims to behave well in setups where many AI tools may be open at once.

- each Godot project gets its own backend
- multiple Claude sessions for the same project can reuse the same backend
- if a live backend socket drops, the bridge exits so Claude can restart it with a clean LSP session

This repository is a **Claude Code plugin**, not a Cursor plugin.

- Cursor will not load this plugin automatically
- Cursor can still connect to Godot independently if you install a Godot extension there
- Cursor is not "stealing" this plugin process, but it may connect to the same Godot ecosystem separately

If you want Claude and another tool to share one manually managed backend, use `attach` mode and point both tools at the same host and port.

## Local Development

For development, load the plugin directly from a checkout:

```shell
claude --plugin-dir ./path/to/claude-code-gdscript
```

Restart Claude Code after changing LSP plugin code.

## Troubleshooting

### Plugin reloads and restarts

- `/reload-plugins` reloads plugins, commands, hooks, and MCP servers
- LSP additions and updates still require a **full Claude Code restart**
- use `claude --debug` to inspect plugin loading and bridge startup logs

If Claude reports:

```text
1 LSP server(s) provided by plugins require restart to activate.
```

that is expected for LSP plugin changes. Restart Claude Code fully.

### "Failed to connect to Godot LSP"

In `auto` mode:

- make sure `godot` is on `PATH`, or set `GODOT_EDITOR_PATH`
- on macOS, point `GODOT_EDITOR_PATH` at `Godot.app/Contents/MacOS/Godot` if needed
- inspect Claude debug logs for structured `startup`, `project_context_resolved`, `connect_retry`, `connected`, and `connect_failed` events
- if Godot restarts while Claude is connected, Claude should restart the bridge cleanly because the plugin enables `restartOnCrash`
- the plugin currently allows up to 5 automatic Claude-side LSP restarts before you need to restart Claude manually
- if the bridge exits with `initialize_missing_project_root`, set `GODOT_PROJECT_ROOT` or use a client that sends `rootUri`, `rootPath`, or `workspaceFolders`

In `attach` mode:

- make sure Godot is already running for the correct project
- make sure `GODOT_LSP_PORT` matches that specific editor instance
- if you run multiple Godot projects, give each editor instance a unique `--lsp-port`

### Reset to manual editor-owned behavior

```sh
export GODOT_LSP_MODE=attach
export GODOT_LSP_HOST=127.0.0.1
export GODOT_LSP_PORT=6005
```

## License

MIT
