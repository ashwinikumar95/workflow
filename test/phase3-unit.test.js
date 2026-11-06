const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, test, before, after, beforeEach } = require("node:test");
const { validateWorkflowGraph } = require("../src/utils/workflowGraph");
const { buildPrompt, START } = require("../src/services/cursorPromptService");
const { analyzeIssue } = require("../src/services/analysisService");
const { prepareJiraDelivery } = require("../src/services/triggerService");
const github = require("../src/services/githubPrService");
const git = require("../src/services/gitService");
const { classifyAgentTree, handleAgentJob } = require("../src/services/agentAttempt");
const { handlePlaywrightJob } = require("../src/services/playwrightAttempt");
const {
  buildAgentContainerSpec,
  buildPlaywrightContainerSpec,
  buildPlaywrightEnv,
  assertPinnedImage,
} = require("../src/services/containerSpec");
const {
  detectPackageManager,
  classifyPlaywrightOutcome,
  resolvePlaywrightLayout,
} = require("../src/services/playwrightPlan");
const { FORBIDDEN_ENV } = require("../src/services/forbiddenEnv");

const DIGEST = `example@sha256:${"a".repeat(64)}`;

function repoConfig(extra = {}) {
  return {
    location: "D:/repos/app",
    defaultBranch: "main",
    credentialRef: "GITHUB_TOKEN",
    ...extra,
  };
}

function playwrightConfig(extra = {}) {
  return {
    strategy: "in-repo",
    target: "local-worktree",
    testPath: "tests",
    appCommand: ["npm", "start"],
    readiness: "/health",
    ...extra,
  };
}

describe("phase 3 unit", () => {
  const saved = {};

  before(() => {
    for (const name of [...FORBIDDEN_ENV, "JIRA_WEBHOOK_SECRET"]) {
      saved[name] = process.env[name];
    }
    process.env.MONGODB_URI = "mongodb://phase3-secret";
    process.env.JWT_SECRET = "jwt-phase3-secret";
    process.env.JIRA_API_TOKEN = "atlassian-phase3-secret";
    process.env.ANALYSIS_API_KEY = "analysis-phase3-secret";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/phase3";
    process.env.GITHUB_TOKEN = "github-phase3-secret";
    process.env.REDIS_PASSWORD = "redis-phase3-secret";
    process.env.JIRA_WEBHOOK_SECRET = "jira-hook-secret";
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.ANALYSIS_BASE_URL = "https://analysis.example.test";
    process.env.ANALYSIS_MODEL = "test-model";
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    git.setGitRunner(null);
  });

  test("analysis schema rejects a bad body and merges a valid one", async () => {
    await assert.rejects(
      () =>
        analyzeIssue(
          { summary: "Login fails", descriptionText: "Steps" },
          {
            http: {
              async post() {
                return { data: { choices: [{ message: { content: JSON.stringify({ summary: 1 }) } }] } };
              },
            },
          }
        )
    );
    const analysis = await analyzeIssue(
      { summary: "Login fails", descriptionText: "Steps" },
      {
        http: {
          async post(url, body) {
            assert.match(url, /\/chat\/completions$/);
            assert.equal(body.response_format.type, "json_object");
            return {
              data: {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        summary: "Fix login",
                        risks: ["auth"],
                        filesLikelyTouched: ["src/auth.js"],
                        acceptanceChecks: ["user can sign in"],
                      }),
                    },
                  },
                ],
              },
            };
          },
        },
      }
    );
    assert.equal(analysis.summary, "Fix login");
    assert.deepEqual(analysis.risks, ["auth"]);
  });

  test("prompt keeps a long description inside the untrusted block", () => {
    const description = "d".repeat(500);
    const text = buildPrompt(
      { summary: "Ticket", descriptionText: `$(rm -rf /) ${description}` },
      { summary: "Fix", risks: [], filesLikelyTouched: [], acceptanceChecks: [] }
    );
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "cursorPromptService.js"), "utf8");
    assert.equal(source.includes("child_process"), false);
    assert.equal(source.includes("interpolateMessage"), false);
    const start = text.indexOf(START);
    assert.ok(start >= 0);
    assert.ok(text.indexOf(description) > start);
    assert.ok(text.includes("$(rm -rf /)"));
    assert.ok(description.length > 200);
  });

  test("publish rules for splits, tokens, playwright, and pull requests", () => {
    const line = validateWorkflowGraph({
      nodes: [{ id: "S", type: "http", config: { url: "https://example.test" } }, { id: "A", type: "delay" }],
      edges: [{ from: "S", to: "A" }],
    });
    assert.equal(line.ok, true);

    const missingStrategy = validateWorkflowGraph({
      repository: repoConfig(),
      nodes: [{ id: "p", type: "playwright", config: { target: "local-worktree" } }],
      edges: [],
    });
    assert.equal(missingStrategy.ok, false);
    assert.match(missingStrategy.message, /strategy/);

    const token = validateWorkflowGraph({
      nodes: [{ id: "h", type: "http", config: { url: "https://example.test", note: "ghp_abcdefghijklmnopqrstuvwxyz" } }],
      edges: [],
    });
    assert.equal(token.ok, false);

    const header = validateWorkflowGraph({
      nodes: [
        {
          id: "h",
          type: "http",
          config: { url: "https://example.test", headers: { Authorization: "Bearer leak-me" } },
        },
      ],
      edges: [],
    });
    assert.equal(header.ok, true);

    const bypass = validateWorkflowGraph({
      repository: repoConfig(),
      nodes: [
        { id: "start", type: "gitBranch", config: {} },
        { id: "pr", type: "githubPr", config: {} },
      ],
      edges: [{ from: "start", to: "pr" }],
    });
    assert.equal(bypass.ok, false);
    assert.match(bypass.message, /Playwright true edge/);

    const secondEdge = validateWorkflowGraph({
      repository: repoConfig(),
      nodes: [
        { id: "start", type: "gitBranch", config: {} },
        { id: "pw", type: "playwright", config: playwrightConfig() },
        { id: "side", type: "notify", config: { message: "hi" } },
        { id: "pr", type: "githubPr", config: {} },
      ],
      edges: [
        { from: "start", to: "pw" },
        { from: "start", to: "side" },
        { from: "pw", to: "pr", condition: "true" },
        { from: "side", to: "pr" },
      ],
    });
    assert.equal(secondEdge.ok, false);
    assert.match(secondEdge.message, /Playwright true edge/);

    const allowed = validateWorkflowGraph({
      repository: repoConfig(),
      nodes: [
        { id: "start", type: "gitBranch", config: {} },
        { id: "pw", type: "playwright", config: playwrightConfig() },
        { id: "pr", type: "githubPr", config: {} },
        { id: "no", type: "notify", config: { message: "failed" } },
      ],
      edges: [
        { from: "start", to: "pw" },
        { from: "pw", to: "pr", condition: "true" },
        { from: "pw", to: "no", condition: "false" },
      ],
    });
    assert.equal(allowed.ok, true);
  });

  test("jira ingress rejects a bad key, event, secret, and mismatched id", async () => {
    const http = { async get() { throw new Error("axios should not be called"); } };
    await assert.rejects(
      () => prepareJiraDelivery({ issueKey: "bad key", eventId: "evt1" }, { "x-webhook-secret": "jira-hook-secret" }, { http }),
      (err) => err.statusCode === 400
    );
    await assert.rejects(
      () => prepareJiraDelivery({ issueKey: "PROJ-1" }, { "x-webhook-secret": "jira-hook-secret" }, { http }),
      (err) => err.statusCode === 400
    );
    await assert.rejects(
      () => prepareJiraDelivery({ issueKey: "PROJ-1", eventId: "evt1" }, { "x-webhook-secret": "nope" }, { http }),
      (err) => err.statusCode === 401
    );

    let gets = 0;
    const prepared = await prepareJiraDelivery(
      { issueKey: "PROJ-1", eventId: "evt_1", issueId: "10001" },
      { "x-webhook-secret": "jira-hook-secret" },
      {
        http: {
          async get() {
            gets += 1;
            return {
              data: {
                id: "10001",
                key: "PROJ-1",
                fields: { summary: "Bug", description: "text", status: { name: "Open" } },
              },
            };
          },
        },
      }
    );
    assert.equal(gets, 1);
    assert.equal(prepared.jobId, "jira_10001_evt_1");
    await assert.rejects(
      () =>
        prepareJiraDelivery(
          { issueKey: "PROJ-1", eventId: "evt_2", issueId: "99999" },
          { "x-webhook-secret": "jira-hook-secret" },
          {
            http: {
              async get() {
                return { data: { id: "10001", key: "PROJ-1", fields: { summary: "Bug", status: { name: "Open" } } } };
              },
            },
          }
        ),
      (err) => err.statusCode === 400
    );
  });

  test("openPullRequest returns an existing url and does not merge", async () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "githubPrService.js"), "utf8");
    assert.equal(source.includes(".merge"), false);
    assert.equal(source.includes("pulls.merge"), false);
    assert.deepEqual(Object.keys(github), ["openPullRequest", "updatePullRequestBody", "pullNumberFromUrl"]);
    let created = 0;
    const url = await github.openPullRequest(
      { owner: "acme", repo: "app", head: "wf/PROJ-1/abc", base: "main", title: "Fix" },
      {
        pulls: {
          async list() {
            return { data: [{ html_url: "https://github.com/acme/app/pull/7" }] };
          },
          async create() {
            created += 1;
            return { data: { html_url: "https://github.com/acme/app/pull/8" } };
          },
        },
      }
    );
    assert.equal(url, "https://github.com/acme/app/pull/7");
    assert.equal(created, 0);
  });

  test("child environments omit workflow secrets", () => {
    const pushEnv = git.buildPushEnv("github-phase3-secret");
    assert.equal(pushEnv.GIT_ASKPASS_TOKEN, "github-phase3-secret");
    for (const name of FORBIDDEN_ENV) assert.equal(Object.hasOwn(pushEnv, name), false);
    const args = git.pushArgs("/tmp/worktree", "abc123", "wf/manual/aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(args.some((arg) => String(arg).includes("github-phase3-secret")), false);
    assert.deepEqual(args.slice(-1), ["abc123:refs/heads/wf/manual/aaaaaaaaaaaaaaaaaaaaaaaa"]);

    const agent = buildAgentContainerSpec({
      worktreePath: "D:/worktrees/one",
      agentExecutionId: "exec-1",
      apiKey: "cursor-key",
      egressHosts: ["api.example.test"],
      image: "workflow-agent:local",
    });
    assert.equal(agent.mounts.filter((mount) => mount.type === "bind").length, 1);
    assert.equal(agent.mounts.filter((mount) => mount.type === "tmpfs").length, 2);
    assert.equal(agent.args.includes("--network=host"), false);
    assert.equal(JSON.stringify(agent).includes("mongodb://phase3-secret"), false);
    assert.equal(JSON.stringify(agent).includes("GITHUB_TOKEN"), false);
    assert.equal(agent.env.GITHUB_TOKEN, undefined);

    const playEnv = buildPlaywrightEnv({
      baseUrl: "http://127.0.0.1:9",
      gitCommit: "abc123",
      extraAllow: ["GITHUB_TOKEN", "SAFE_FLAG"],
    });
    process.env.SAFE_FLAG = "1";
    const playEnv2 = buildPlaywrightEnv({
      baseUrl: "http://127.0.0.1:9",
      gitCommit: "abc123",
      extraAllow: ["GITHUB_TOKEN", "SAFE_FLAG"],
    });
    assert.equal(playEnv2.SAFE_FLAG, "1");
    assert.equal(playEnv2.GITHUB_TOKEN, undefined);
    assert.equal(playEnv.CI, "1");
    const play = buildPlaywrightContainerSpec({
      image: DIGEST,
      testCwd: "D:/worktrees/tests",
      appWorktree: "D:/worktrees/app",
      strategy: "external-repo",
      env: playEnv2,
    });
    assert.equal(JSON.stringify(play).includes("mongodb://phase3-secret"), false);
    assert.equal(JSON.stringify(play).includes("GITHUB_TOKEN"), false);
    assert.throws(() => assertPinnedImage("mcr.microsoft.com/playwright:latest"));
  });

  test("agent classification does not treat a clean tree or a dirty retry as success", async () => {
    const finished = classifyAgentTree({
      clean: true,
      head: "aaa",
      preAgentSha: "aaa",
      descendant: true,
      diffEmpty: true,
      sdkStatus: "finished",
      hasReceipt: true,
      containerRunning: false,
    });
    assert.equal(finished.action, "settle");
    assert.equal(finished.branch, "false");

    const committed = classifyAgentTree({
      clean: true,
      head: "bbb",
      preAgentSha: "aaa",
      descendant: true,
      diffEmpty: false,
      hasReceipt: true,
      containerRunning: false,
    });
    assert.equal(committed.branch, "true");
    assert.equal(committed.action, "settle");

    let started = 0;
    const settled = [];
    await handleAgentJob(
      {
        data: {
          runId: "a".repeat(24),
          nodeId: "agent1",
          externalJobId: `agent-${"a".repeat(24)}-agent1`,
          worktreePath: "D:/wt",
          preAgentSha: "aaa",
          agentExecutionId: "exec",
        },
      },
      {
        findEscapingSymlink: async () => null,
        inspect: async () => ({
          clean: false,
          head: "aaa",
          preAgentSha: "aaa",
          descendant: true,
          diffEmpty: true,
          hasReceipt: false,
        }),
        enqueueSettle: async (payload) => settled.push(payload),
        startContainer: async () => {
          started += 1;
        },
        egressHosts: ["api.example.test"],
      }
    );
    assert.equal(started, 0);
    assert.equal(settled[0].result.branch, "false");

    await assert.rejects(() =>
      handleAgentJob(
        {
          data: {
            runId: "b".repeat(24),
            nodeId: "agent1",
            externalJobId: `agent-${"b".repeat(24)}-agent1`,
            worktreePath: "D:/wt",
            preAgentSha: "abc",
            agentExecutionId: "exec",
          },
        },
        {
          findEscapingSymlink: async () => null,
          inspect: async () => ({
            clean: true,
            head: "abc",
            preAgentSha: "abc",
            descendant: true,
            diffEmpty: true,
            hasReceipt: false,
          }),
          enqueueSettle: async () => {},
          startContainer: async () => {
            throw Object.assign(new Error("CursorAgentError"), { retryable: true, name: "CursorAgentError" });
          },
          egressHosts: ["api.example.test"],
        }
      )
    );
  });

  test("sandbox uses Agent.create with local cwd and no cloud runtime", async () => {
    const lib = fs.readFileSync(path.join(__dirname, "..", "scripts", "agent-sandbox-lib.mjs"), "utf8");
    const entry = fs.readFileSync(path.join(__dirname, "..", "scripts", "agent-sandbox-entry.mjs"), "utf8");
    assert.match(lib, /Agent\.create/);
    assert.equal(lib.includes("Agent.prompt"), false);
    assert.equal(lib.includes("cloud:"), false);
    assert.match(entry, /@cursor\/sdk/);
    assert.equal(entry.includes("Agent.prompt"), false);
    const seen = [];
    const Agent = {
      async create(options) {
        seen.push(options);
        return {
          agentId: "agent-1",
          async send() {
            return { id: "run-1", async wait() { return { status: "finished" }; } };
          },
          async [Symbol.asyncDispose]() {},
        };
      },
    };
    const { runSandbox } = await import("../scripts/agent-sandbox-lib.mjs");
    const result = await runSandbox({
      Agent,
      apiKey: "cursor-key",
      cwd: "/worktree",
      prompt: "implement the ticket",
      modelId: "composer-2.5",
      writeReceipt: async () => {},
    });
    assert.equal(result.status, "finished");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].local.cwd, "/worktree");
    assert.deepEqual(seen[0].local.settingSources, ["project"]);
    assert.equal(seen[0].cloud, undefined);
    assert.equal(Agent.prompt, undefined);
  });

  test("playwright bootstrap, timeout, strategy, and revision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pw-"));
    const none = path.join(root, "none");
    const both = path.join(root, "both");
    const npmDir = path.join(root, "npm");
    fs.mkdirSync(none);
    fs.mkdirSync(both);
    fs.mkdirSync(npmDir);
    fs.writeFileSync(path.join(both, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(both, "yarn.lock"), "");
    fs.writeFileSync(path.join(npmDir, "package-lock.json"), "{}");
    assert.equal(detectPackageManager(none).status, "bootstrap-failed");
    assert.equal(detectPackageManager(both).status, "bootstrap-failed");
    assert.deepEqual(detectPackageManager(npmDir).command, ["npm", "ci"]);
    assert.equal(classifyPlaywrightOutcome({ installCode: 1 }).status, "bootstrap-failed");
    assert.notEqual(classifyPlaywrightOutcome({ installCode: 1 }).status, "failed");
    assert.equal(classifyPlaywrightOutcome({ installCode: 0, browserCode: 1 }).status, "bootstrap-failed");
    assert.equal(classifyPlaywrightOutcome({ installCode: 0, browserCode: 0, timedOut: true }).status, "timed-out");
    assert.equal(classifyPlaywrightOutcome({ installCode: 0, browserCode: 0, testCode: 0, reportPresent: false }).failureClass, "missing-report");

    const layoutIn = resolvePlaywrightLayout({
      strategy: "in-repo",
      appWorktree: "D:/app",
      testWorktree: "D:/tests",
    });
    assert.equal(layoutIn.testCwd, "D:/app");
    assert.equal(layoutIn.appCwd, "D:/app");
    const layoutOut = resolvePlaywrightLayout({
      strategy: "external-repo",
      appWorktree: "D:/app",
      testWorktree: "D:/tests",
    });
    assert.equal(layoutOut.testCwd, "D:/tests");
    assert.equal(layoutOut.appCwd, "D:/app");

    const calls = [];
    const githubCalls = [];
    const original = github.openPullRequest;
    github.openPullRequest = async () => {
      githubCalls.push("open");
      return "https://github.com/acme/app/pull/1";
    };
    try {
      const job = {
        data: {
          runId: "c".repeat(24),
          nodeId: "pw",
          externalJobId: `playwright-${"c".repeat(24)}-pw`,
          strategy: "in-repo",
          target: "local-worktree",
          testedSha: "good",
          appWorktree: npmDir,
          testWorktree: npmDir,
        },
      };
      await handlePlaywrightJob(job, {
        enqueueSettle: async (payload) => calls.push(payload),
        revParse: async () => "good",
        install: async () => ({ code: 1, stdout: "", stderr: "npm ci failed" }),
      });
      await handlePlaywrightJob(
        { data: { ...job.data, target: "local-worktree" } },
        {
          enqueueSettle: async (payload) => calls.push(payload),
          revParse: async () => "good",
          timedOut: true,
        }
      );
      await handlePlaywrightJob(
        {
          data: {
            ...job.data,
            strategy: "external-repo",
            appWorktree: "D:/app",
            testWorktree: npmDir,
            testedSha: "good",
          },
        },
        {
          enqueueSettle: async (payload) => calls.push(payload),
          revParse: async () => "other",
          runSuite: async () => {
            throw new Error("suite should not start");
          },
        }
      );
    } finally {
      github.openPullRequest = original;
    }
    assert.equal(calls[0].result.status, "bootstrap-failed");
    assert.equal(calls[1].result.status, "timed-out");
    assert.equal(calls[2].result.branch, "false");
    assert.equal(githubCalls.length, 0);
    assert.equal(calls.some((call) => call.result.status === "passed"), false);
  });
});
