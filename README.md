# claude-code-gdscript

GDScript language support for [Claude Code](https://claude.ai/code) via Godot's built-in LSP server.

Provides diagnostics, go-to-definition, hover, symbols, and completions for `.gd` files — all powered by Godot's native language server.

## How It Works

Godot 4.x includes a built-in LSP server that speaks TCP (port 6005). Claude Code expects language servers over stdio. This plugin includes a lightweight Node.js bridge that translates between the two:

```
Claude Code ◄── stdio ──► bridge ◄── TCP ──► Godot LSP (port 6005)
```

No external dependencies — just Node.js (already required by Claude Code).

## Prerequisites

- **Godot 4.x** editor running with your project open, OR started headless:
  ```sh
  godot --gdscript-lsp --path /path/to/your/project
  ```
- **Node.js** (comes with Claude Code)

## Installation

```sh
claude /install-plugin ~/personal/claude-code-gdscript
```

Or from a clone:

```sh
git clone https://github.com/youruser/claude-code-gdscript.git
claude /install-plugin ./claude-code-gdscript
```

## Usage

1. Start Godot editor with your project open (or use headless mode above)
2. Open a Claude Code session in your Godot project directory
3. GDScript language features should be active automatically for `.gd` files

### Features

- **Diagnostics** — syntax and type errors surfaced automatically
- **Go-to-definition** — navigate to function/variable declarations
- **Hover** — type info and documentation on symbols
- **Document symbols** — outline of functions, variables, signals
- **Completions** — context-aware code suggestions

## Configuration

| Environment Variable | Default       | Description                  |
|---------------------|---------------|------------------------------|
| `GODOT_LSP_HOST`   | `127.0.0.1`  | Godot LSP server host        |
| `GODOT_LSP_PORT`   | `6005`        | Godot LSP server port        |

## Troubleshooting

**"Failed to connect to Godot LSP"** — Make sure Godot editor is running with your project open. The LSP server starts automatically when the editor opens.

**Port conflict** — If another instance of Godot is using port 6005, set a custom port:
```sh
export GODOT_LSP_PORT=6006
```

## License

MIT
