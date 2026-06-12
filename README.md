# OpenEvolve
Give everyone a personal agent that evolves on its own.
## Quick Start

```bash
# Install dependencies
bun install

# Start (TUI mode)
bun start

# Start headless
NO_TUI=1 bun start

# Run tests
bun test
```

## Architecture

OpenEvolve is built around a typed **EventBus**. Modules subscribe to events, react to them, and publish new events — they never call each other directly. The agent has three evolution chains:

- **Repair** — detects failures, generates patches, evaluates, and deploys fixes automatically
- **Scout** — discovers new capabilities from GitHub, npm, HN, MCP registries, then scores, builds, and installs them as plugins
- **Browser** — searches the web, fetches pages, executes automation tasks, and takes screenshots via Playwright

### HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Agent health and LLM status |
| `/chat` | POST | Chat with the agent (`{"message": "..."}`) |
| `/models` | GET | List all models with status |
| `/models/default` | PUT | Switch default model (`{"modelId": "..."}`) |
| `/models/route` | PUT | Set per-task route (`{"taskType": "...", "modelId": "..."}`) |
| `/models/check` | POST | Check model availability |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NO_TUI` | `false` | Start in headless mode |
| `LLM_DEFAULT_MODEL` | `deepseek-v4-pro` | Default LLM model |
| `BROWSER_HEADLESS` | `true` | Run Playwright headless |
| `Z_AI_WEB_DEV_API_KEY` | — | API key for z-ai-web-dev-sdk |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Language**: TypeScript (executed directly, no build step)
- **LLM SDK**: z-ai-web-dev-sdk
- **Browser**: Playwright (Chromium)
- **TUI**: blessed + blessed-contrib
