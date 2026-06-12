/**
 * LLM Model Configuration Types
 *
 * Defines the type system for the multi-model configuration layer.
 * Supports multiple providers, task-based routing, and runtime switching.
 */

// ===== Provider Types =====

export type LLMProviderType = "zai" | "openai" | "anthropic" | "deepseek" | "custom";

export type LLMModelStatus = "available" | "unavailable" | "rate_limited" | "error";

export interface LLMModelConfig {
  /** Unique identifier for this model configuration */
  id: string;
  /** Human-readable name */
  name: string;
  /** Provider type */
  provider: LLMProviderType;
  /** Model identifier (e.g., "deepseek-v4-pro", "gpt-4", "claude-3.5-sonnet") */
  model: string;
  /** Base URL override (optional, for custom endpoints) */
  baseUrl?: string;
  /** API key (read from env, not stored in config) */
  apiKeyEnvVar?: string;
  /** Maximum tokens for completion */
  maxTokens?: number;
  /** Temperature (0.0 - 2.0) */
  temperature?: number;
  /** Top-P (0.0 - 1.0) */
  topP?: number;
  /** Whether this is the default model */
  isDefault?: boolean;
  /** Current status */
  status: LLMModelStatus;
  /** Rate limit: max requests per minute */
  rateLimitRpm?: number;
  /** Cost per 1K input tokens (USD) */
  costPer1kInput?: number;
  /** Cost per 1K output tokens (USD) */
  costPer1kOutput?: number;
  /** Priority (lower = preferred) */
  priority?: number;
}

// ===== Task Routing Types =====

export type LLMTaskType =
  | "chat"           // General conversation
  | "patch_generate" // Self-repair: generate patches
  | "feature_analyze" // Analyze external features
  | "spec_generate"  // Generate feature specs
  | "prototype_build" // Generate plugin prototypes
  | "code_review"    // Code review tasks
  | "summarize"      // Summarization tasks
  | "embedding";     // Embedding tasks

export interface LLMTaskRoute {
  /** Task type */
  taskType: LLMTaskType;
  /** Model ID to use for this task */
  modelId: string;
  /** Optional task-specific overrides */
  overrides?: Partial<Pick<LLMModelConfig, "maxTokens" | "temperature" | "topP">>;
}

// ===== Request/Response Types =====

export interface LLMChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface LLMRequest {
  /** Task type for routing */
  taskType: LLMTaskType;
  /** Chat messages */
  messages: LLMChatMessage[];
  /** Override the routed model (optional) */
  modelId?: string;
  /** Override max tokens */
  maxTokens?: number;
  /** Override temperature */
  temperature?: number;
  /** Request metadata for tracing */
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  /** Response text content */
  content: string;
  /** Model that was actually used */
  modelId: string;
  /** Model name (e.g. "deepseek-v4-pro") */
  modelName: string;
  /** Provider type */
  provider: LLMProviderType;
  /** Token usage stats */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether a fallback model was used */
  fallbackUsed: boolean;
}

export interface LLMProvider {
  /** Provider type identifier */
  type: LLMProviderType;
  /** Check if this provider is available */
  isAvailable(): Promise<boolean>;
  /** Send a chat completion request */
  chat(request: {
    model: string;
    messages: LLMChatMessage[];
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  }): Promise<{
    content: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }>;
}

// ===== Configuration File Type =====

export interface LLMConfigFile {
  /** Model configurations */
  models: LLMModelConfig[];
  /** Task routing rules */
  routes: LLMTaskRoute[];
  /** Default model ID (used when no route matches) */
  defaultModelId: string;
  /** Fallback model IDs (tried in order when primary fails) */
  fallbackModelIds: string[];
  /** Global settings */
  settings?: {
    /** Request timeout in milliseconds */
    requestTimeoutMs?: number;
    /** Max retries before falling back */
    maxRetries?: number;
    /** Whether to log all LLM requests/responses */
    verboseLogging?: boolean;
  };
}
