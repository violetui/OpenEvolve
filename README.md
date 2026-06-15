# OpenEvolve
Give everyone a personal agent that evolves on its own.
## Quick Start

```bash
# Install dependencies
bun install

# Edit config.json to set your API keys and model preferences
# (see Configuration section below)

# Start (TUI mode)
bun start

# Start headless
NO_TUI=1 bun start

# Run tests
bun test
```

## Configuration

All settings are in `config.json`. Environment variables override config file values.

### System Settings (`system`)

| Field | Type | Description |
|-------|------|-------------|
| `port` | number | HTTP server port (env: `PORT`) |
| `noTui` | boolean | Start headless (env: `NO_TUI`) |
| `version` | string | Agent version string |
| `apiKey` | string | Global API key, used by all models that don't specify their own |
| `browser.headless` | boolean | Run Playwright headless (env: `BROWSER_HEADLESS`) |
| `browser.slowMo` | number | Delay between Playwright actions in ms |

### LLM Models (`llm.models[]`)

Each model object:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique model ID |
| `name` | string | Display name |
| `provider` | string | Provider type: `"openai"` or `"custom"` |
| `model` | string | Model name sent to API |
| `apiKey` | string | Per-model API key (falls back to `system.apiKey` then `OPENAI_API_KEY` env) |
| `baseUrl` | string | Per-model base URL override (falls back to `OPENAI_BASE_URL` env) |
| `maxTokens` | number | Max completion tokens |
| `temperature` | number | Temperature (0.0–2.0) |
| `isDefault` | boolean | Whether this is the default model |
| `status` | string | `"available"`, `"unavailable"`, `"rate_limited"`, `"error"` |
| `priority` | number | Lower = preferred when choosing fallback |

Example: adding a new model with its own API key and base URL:

```json
{
  "id": "my-custom-model",
  "name": "My Custom LLM",
  "provider": "openai",
  "model": "my-model-name",
  "apiKey": "sk-xxx",
  "baseUrl": "https://my-api.example.com/v1",
  "maxTokens": 4096,
  "temperature": 0.7,
  "status": "available",
  "priority": 2
}
```

### Task Routes (`llm.routes[]`)

Route different task types to different models:

```json
{ "taskType": "summarize", "modelId": "gpt-4o-mini", "overrides": { "temperature": 0.5 } }
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
| `OPENAI_API_KEY` | — | API key for OpenAI-compatible APIs |
| `OPENAI_BASE_URL` | — | Optional base URL override for the API endpoint |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Language**: TypeScript (executed directly, no build step)
- **LLM SDK**: openai
- **Browser**: Playwright (Chromium)
- **TUI**: blessed + blessed-contrib
