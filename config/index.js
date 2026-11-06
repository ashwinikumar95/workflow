const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

/**
 * Base-10 integer greater than zero. Anything else uses `fallback`.
 * @param {unknown} value
 * @param {number} fallback
 */
function parsePositiveInt(value, fallback) {
  let text;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return fallback;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return fallback;
  }
  if (!/^[0-9]+$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return String(raw).trim() === "true";
}

function splitCsv(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseJsonStringArray(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  uploadsDir: path.join(__dirname, "..", "uploads"),
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  parsePositiveInt,
  httpTimeoutMs: parsePositiveInt(process.env.HTTP_TIMEOUT_MS, 15000),
  workerLockDurationMs: parsePositiveInt(process.env.WORKER_LOCK_DURATION_MS, 30000),
  executionClaimLeaseMs: parsePositiveInt(process.env.EXECUTION_CLAIM_LEASE_MS, 30000),

  /**
   * Unset stays on so `npm run dev` keeps the scheduler and the workflow worker
   * in the API process. Workers set these to false.
   */
  get schedulerEnabled() {
    return envFlag("SCHEDULER_ENABLED", true);
  },
  get workflowWorkerEnabled() {
    return envFlag("WORKFLOW_WORKER_ENABLED", true);
  },

  get jiraBaseUrl() {
    return process.env.JIRA_BASE_URL || "";
  },
  get jiraEmail() {
    return process.env.JIRA_EMAIL || "";
  },
  get jiraApiToken() {
    return process.env.JIRA_API_TOKEN || "";
  },
  get jiraWebhookSecret() {
    return process.env.JIRA_WEBHOOK_SECRET || "";
  },
  /**
   * Cron for the Jira bucket dispatcher. Unset defaults to every 5 minutes.
   * An empty string disables it.
   */
  get jiraDispatchCron() {
    if (process.env.JIRA_DISPATCH_CRON === "") return "";
    return process.env.JIRA_DISPATCH_CRON || "*/5 * * * *";
  },
  /**
   * Cap on issues pulled per profile per dispatcher poll. A large bucket is
   * truncated rather than walked until Jira rate-limits the worker.
   */
  get jiraSearchMaxIssues() {
    return parsePositiveInt(process.env.JIRA_SEARCH_MAX_ISSUES, 200);
  },
  /**
   * Pause between Jira search pages. `0` disables the pause (tests).
   */
  get jiraSearchPageDelayMs() {
    const raw = process.env.JIRA_SEARCH_PAGE_DELAY_MS;
    if (raw !== undefined && String(raw).trim() === "0") return 0;
    return parsePositiveInt(raw, 100);
  },
  get analysisBaseUrl() {
    return process.env.ANALYSIS_BASE_URL || "";
  },
  get analysisApiKey() {
    return process.env.ANALYSIS_API_KEY || "";
  },
  get analysisModel() {
    return process.env.ANALYSIS_MODEL || "";
  },
  get gitRepoPath() {
    return process.env.GIT_REPO_PATH || "";
  },
  get gitBaseBranch() {
    return process.env.GIT_BASE_BRANCH || "";
  },
  get worktreesDir() {
    return process.env.WORKTREES_DIR || "";
  },
  get githubToken() {
    return process.env.GITHUB_TOKEN || "";
  },
  get githubOwner() {
    return process.env.GITHUB_OWNER || "";
  },
  get githubRepo() {
    return process.env.GITHUB_REPO || "";
  },
  get cursorApiKey() {
    return process.env.CURSOR_API_KEY || "";
  },
  get cursorModel() {
    return process.env.CURSOR_MODEL || "composer-2.5";
  },
  get cursorEgressHosts() {
    return splitCsv(process.env.CURSOR_EGRESS_HOSTS);
  },
  get agentRuntime() {
    return process.env.AGENT_RUNTIME || "docker";
  },
  get agentTimeoutMs() {
    return parsePositiveInt(process.env.AGENT_TIMEOUT_MS, 1800000);
  },
  get agentMemory() {
    return process.env.AGENT_MEMORY || "2g";
  },
  get agentCpus() {
    return process.env.AGENT_CPUS || "1";
  },
  get agentPids() {
    return process.env.AGENT_PIDS || "256";
  },
  get playwrightRepoPath() {
    return process.env.PLAYWRIGHT_REPO_PATH || "";
  },
  get playwrightRepoRevision() {
    return process.env.PLAYWRIGHT_REPO_REVISION || "";
  },
  get playwrightWorktreesDir() {
    return process.env.PLAYWRIGHT_WORKTREES_DIR || "";
  },
  get playwrightImage() {
    return process.env.PLAYWRIGHT_IMAGE || "";
  },
  get playwrightArgs() {
    return parseJsonStringArray(process.env.PLAYWRIGHT_ARGS, ["test"]);
  },
  get playwrightTimeoutMs() {
    return parsePositiveInt(process.env.PLAYWRIGHT_TIMEOUT_MS, 600000);
  },
  get playwrightEnvAllow() {
    return splitCsv(process.env.PLAYWRIGHT_ENV_ALLOW);
  },
  get playwrightBrowsersPath() {
    return process.env.PLAYWRIGHT_BROWSERS_PATH || "";
  },
  get playwrightCacheDir() {
    return process.env.PLAYWRIGHT_CACHE_DIR || "";
  },
  get playwrightArtifactsDir() {
    return process.env.PLAYWRIGHT_ARTIFACTS_DIR || "";
  },
  get artifactsDir() {
    return process.env.ARTIFACTS_DIR || process.env.PLAYWRIGHT_ARTIFACTS_DIR || "";
  },
  get artifactRetentionPublicDays() {
    return parsePositiveInt(process.env.ARTIFACT_RETENTION_PUBLIC_DAYS, 30);
  },
  get artifactRetentionPrivateDays() {
    return parsePositiveInt(process.env.ARTIFACT_RETENTION_PRIVATE_DAYS, 7);
  },
  get playwrightMemory() {
    return process.env.PLAYWRIGHT_MEMORY || "2g";
  },
  get playwrightCpus() {
    return process.env.PLAYWRIGHT_CPUS || "1";
  },

  /** Optional: Slack incoming webhook for Notify node + run failure alerts */
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,

  /** Public origin for run links in Slack (no trailing slash). */
  get appBaseUrl() {
    const raw = process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || "";
    if (raw.trim()) return raw.trim().replace(/\/$/, "");
    return `http://localhost:${this.port}`;
  },

  /** BullMQ / ioredis — used by `src/services/queue.js` and `src/workers/worker.js` */
  redisHost: process.env.REDIS_HOST || "127.0.0.1",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || undefined,

  get redisConnection() {
    const c = {
      host: this.redisHost,
      port: this.redisPort
    };
    if (this.redisPassword) c.password = this.redisPassword;
    return c;
  }
};
