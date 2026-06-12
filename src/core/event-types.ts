export type AgentEvents = {
  "agent.message.received": {
    message: string;
    userId?: string;
  };

  "agent.message.completed": {
    message: string;
    result: string;
  };

  "agent.failure.reported": {
    errorType: "runtime_error" | "user_correction" | "tool_error" | "test_failure";
    message: string;
    stack?: string;
    relatedSkill?: string;
    userMessage?: string;
  };
};

export type EvolutionEvents = {
  "evolution.analysis.requested": {
    failureEventId: string;
  };

  "evolution.patch.proposed": {
    reason: string;
    risk: string;
    changes: Array<{
      path: string;
      operation: "replace_file";
      content: string;
    }>;
  };

  "evolution.patch.applied": {
    workspace: string;
    changedFiles: string[];
  };

  "evolution.eval.requested": {
    workspace: string;
  };

  "evolution.eval.passed": {
    workspace: string;
    checks: string[];
  };

  "evolution.eval.failed": {
    workspace: string;
    reason: string;
  };
};

export type ReleaseEvents = {
  "release.created": {
    releasePath: string;
    version: string;
  };

  "deploy.requested": {
    releasePath: string;
    version: string;
  };

  "deploy.succeeded": {
    version: string;
  };

  "deploy.rollbacked": {
    failedVersion: string;
    rollbackVersion: string;
    reason: string;
  };
};

// ===== External Capability Discovery Event Chain =====

export type FeatureEvents = {
  "feature.scout.requested": {
    topics?: string[];
    sources?: FeatureSourceType[];
    triggeredBy: "scheduler" | "manual" | "plugin";
  };

  "feature.sources.discovered": {
    sources: Array<{
      type: FeatureSourceType;
      url: string;
      name: string;
      description: string;
    }>;
  };

  "feature.candidate.found": {
    candidate: FeatureCandidatePayload;
  };

  "feature.candidate.scored": {
    candidateId: string;
    scores: FeatureScorePayload;
    finalScore: number;
    passed: boolean;
  };

  "feature.spec.generated": {
    candidateId: string;
    spec: FeatureSpecPayload;
  };

  "feature.prototype.requested": {
    candidateId: string;
    spec: FeatureSpecPayload;
  };

  "feature.prototype.created": {
    candidateId: string;
    workspace: string;
    pluginName: string;
    files: string[];
  };

  "feature.eval.requested": {
    candidateId: string;
    workspace: string;
  };

  "feature.eval.passed": {
    candidateId: string;
    workspace: string;
    checks: string[];
  };

  "feature.eval.failed": {
    candidateId: string;
    workspace: string;
    reason: string;
  };

  "plugin.install.requested": {
    candidateId: string;
    pluginName: string;
    installLevel: FeatureInstallLevel;
    workspace: string;
  };

  "plugin.installed": {
    candidateId: string;
    pluginName: string;
    installLevel: FeatureInstallLevel;
    installPath: string;
  };
};

// ===== Plugin Runtime Feedback Event Chain =====

export type PluginRuntimeEvents = {
  "plugin.used": {
    pluginName: string;
    invokedBy: string;
    success: boolean;
    durationMs: number;
  };

  "plugin.failure.reported": {
    pluginName: string;
    errorType: "runtime_error" | "permission_error" | "timeout_error" | "security_violation";
    message: string;
    stack?: string;
  };

  "plugin.updated": {
    pluginName: string;
    previousVersion: string;
    newVersion: string;
    reason: string;
  };

  "plugin.disabled": {
    pluginName: string;
    reason: string;
  };
};

// ===== New: Browser Automation Event Chain =====

export type BrowserEvents = {
  /** Browser search request: search keywords via search engine */
  "browser.search.requested": {
    query: string;
    engine?: "google" | "bing" | "duckduckgo" | "baidu";
    maxResults?: number;
  };

  /** Browser search completed: return search results */
  "browser.search.completed": {
    query: string;
    results: Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
  };

  /** Browser page fetch request: visit URL and extract content */
  "browser.fetch.requested": {
    url: string;
    selector?: string;
    waitFor?: number;
  };

  /** Browser page fetch completed: return page content */
  "browser.fetch.completed": {
    url: string;
    title: string;
    content: string;
    statusCode: number;
  };

  /** Browser automation task request: execute custom step sequence */
  "browser.task.requested": {
    taskName: string;
    steps: BrowserStep[];
    timeout?: number;
  };

  /** Browser automation task step completed */
  "browser.task.step.completed": {
    taskName: string;
    stepIndex: number;
    stepType: BrowserStep["type"];
    success: boolean;
    data?: string;
  };

  /** Browser automation task completed */
  "browser.task.completed": {
    taskName: string;
    totalSteps: number;
    completedSteps: number;
    screenshot?: string;
  };

  /** Browser action failed */
  "browser.action.failed": {
    action: string;
    url?: string;
    error: string;
  };

  /** Browser ready: browser instance has started */
  "browser.ready": {
    browserType: string;
    headless: boolean;
  };

  /** Browser screenshot request */
  "browser.screenshot.requested": {
    url: string;
    fullPage?: boolean;
    selector?: string;
  };

  /** Browser screenshot completed */
  "browser.screenshot.completed": {
    url: string;
    imagePath: string;
    width: number;
    height: number;
  };
};

export type BrowserStep = {
  type: "navigate" | "click" | "type" | "wait" | "extract" | "screenshot" | "scroll";
  selector?: string;
  value?: string;
  timeout?: number;
};

export type SystemEvents = {
  "system.module.started": {
    moduleName: string;
  };

  "system.plugin.loaded": {
    pluginName: string;
    version: string;
  };

  "system.event.failed": {
    eventType: string;
    handler: string;
    error: string;
  };
};

// ===== Helper Types =====

export type FeatureSourceType =
  | "github"
  | "mcp_registry"
  | "npm"
  | "blog"
  | "paper"
  | "product_changelog";

export type FeatureCapabilityType =
  | "plugin"
  | "skill"
  | "tool"
  | "workflow"
  | "security"
  | "memory"
  | "evaluation"
  | "deployment";

export type FeatureCandidateStatus =
  | "discovered"
  | "scored"
  | "rejected"
  | "spec_generated"
  | "prototype_created"
  | "eval_passed"
  | "installed";

export type FeatureInstallLevel = 1 | 2 | 3 | 4;

export type FeatureCandidatePayload = {
  id: string;
  title: string;
  source: FeatureSourceType;
  url: string;
  summary: string;
  capabilityType: FeatureCapabilityType;
  proposedUse: string;
  scores: {
    usefulness: number;
    frequency: number;
    integration: number;
    security: number;
    maintenance: number;
    novelty: number;
    overlap: number;
  };
  status: FeatureCandidateStatus;
};

export type FeatureScorePayload = {
  usefulness: number;
  frequency: number;
  integration: number;
  security: number;
  maintenance: number;
  novelty: number;
  overlap: number;
};

export type FeatureSpecPayload = {
  id: string;
  type: FeatureCapabilityType;
  description: string;
  permissions: {
    network?: {
      allow: string[];
    };
    filesystem?: {
      read: string[];
      write: string[];
    };
  };
  events: {
    subscribes: string[];
    publishes: string[];
  };
  riskLevel: "low" | "medium" | "high" | "critical";
  evals: string[];
  installLevel: FeatureInstallLevel;
};

// ===== LLM Model Configuration Events =====

export type LLMEvents = {
  /** LLM chat request initiated */
  "llm.chat.requested": {
    taskType: string;
    modelId: string;
    messageCount: number;
  };

  /** LLM chat completed successfully */
  "llm.chat.completed": {
    taskType: string;
    modelId: string;
    modelName: string;
    provider: string;
    content: string;
    durationMs: number;
    tokensUsed?: number;
    fallbackUsed: boolean;
  };

  /** LLM chat failed */
  "llm.chat.failed": {
    taskType: string;
    modelId: string;
    error: string;
  };

  /** Model switched at runtime */
  "llm.model.switched": {
    previousModelId: string;
    newModelId: string;
    switchedBy: string;
  };

  /** Model availability changed */
  "llm.model.status_changed": {
    modelId: string;
    previousStatus: string;
    newStatus: string;
  };

  /** Route updated */
  "llm.route.updated": {
    taskType: string;
    previousModelId: string;
    newModelId: string;
  };
};

// ===== Merge All Events =====

export type AppEventMap =
  AgentEvents &
  EvolutionEvents &
  ReleaseEvents &
  FeatureEvents &
  PluginRuntimeEvents &
  BrowserEvents &
  LLMEvents &
  SystemEvents;

export type EventType = keyof AppEventMap;
