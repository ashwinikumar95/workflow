const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Run = require("../src/models/Run");
const Workflow = require("../src/models/workflow");
const TicketRun = require("../src/models/TicketRun");
const ResourceLock = require("../src/models/ResourceLock");
const rulesService = require("../src/services/rulesService");
const rulesChecks = require("../src/services/rulesChecks");
const lifecycle = require("../src/nodes/lifecycle");
const jira = require("../src/services/jiraService");
const dispatcher = require("../src/services/jiraDispatcher");
const recovery = require("../src/services/recovery");
const retention = require("../src/services/retention");
const { parseProfiles } = require("../src/services/projectRegistry");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
  sleep,
} = require("../test-support/helpers");

const MFC_FIXTURE = path.join(__dirname, "fixtures", "rules", "mfc");
const MFC_DRAFT = path.join(__dirname, "..", "config", "mfc-rules");
const ROOT_IMPL = path.join(__dirname, "..", "implementation.md");
const DAY = 24 * 60 * 60 * 1000;
const ALWAYS_MFC = [
  ".cursor/rules/central-project-rules.mdc",
  ".cursor/rules/native-components-rules.mdc",
  ".cursor/rules/new-component-rules.mdc",
  ".cursor/rules/security-rules.mdc",
];
const GLOB_MFC = [
  ".cursor/rules/performance-optimization-rules.mdc",
  ".cursor/rules/testing-validation-rules.mdc",
  ".cursor/rules/vxceed-grid-rules.mdc",
];
const COMPOSITION_MFC = [
  ".cursor/rules/DEVELOPER_PROMPT.md",
  ".cursor/rules/COMPOSITION_API_EXPLAINED.md",
];
const DOWNSTREAM_MFC = [
  ".cursor/rules/DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md",
  ".cursor/rules/DOWNSTREAM_MIGRATION_REVIEW_SKILL.md",
];

const PREV_BASE = process.env.JIRA_BASE_URL;
const PREV_EMAIL = process.env.JIRA_EMAIL;
const PREV_TOKEN = process.env.JIRA_API_TOKEN;

function issuePayload(key, extra = {}) {
  const description = Object.prototype.hasOwnProperty.call(extra, "description")
    ? extra.description
    : "Acceptance: user can complete the flow.";
  return {
    id: extra.id || String(10000 + Number(String(key).replace(/\D/g, "") || 1)),
    key,
    fields: {
      summary: extra.summary ?? `Work ${key}`,
      description,
      status: { name: extra.status || "To Do" },
      issuetype: { name: extra.issueType || "Story" },
      labels: extra.labels || [],
      components: extra.components || [{ name: "UI" }],
      updated: extra.updated || "2026-11-06T00:00:00.000Z",
    },
  };
}

function rateLimit(retryAfter = "0") {
  const err = new Error("rate limited");
  err.response = { status: 429, headers: { "retry-after": retryAfter } };
  return err;
}

async function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 100000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function waitAlive(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await isAlive(pid)) && Date.now() < deadline) await sleep(20);
  assert.equal(await isAlive(pid), true);
}

async function waitDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while ((await isAlive(pid)) && Date.now() < deadline) await sleep(50);
  assert.equal(await isAlive(pid), false);
}

describe("jira-pr phase 11 MFC and hardening", () => {
  let root;

  before(async () => {
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.test";
    process.env.JIRA_API_TOKEN = "token";
    await connectTestDb();
    await TicketRun.syncIndexes();
    await ResourceLock.syncIndexes();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase11-"));
  });

  after(async () => {
    await disconnectTestDb();
    if (PREV_BASE === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = PREV_BASE;
    if (PREV_EMAIL === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = PREV_EMAIL;
    if (PREV_TOKEN === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = PREV_TOKEN;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(async () => {
    await clearTestData();
  });

  test("MFC is enabled and still linked to TAC", () => {
    const profiles = parseProfiles();
    assert.equal(profiles.MFC.enabled, true);
    assert.equal(profiles.MFC.kind, "app");
    assert.equal(profiles.MFC.linkedProfile, "TAC");
    assert.equal(profiles.TAC.linkedProfile, "MFC");
    assert.equal(profiles.MFC.repo.github.repo, "Mt-Fuji-Central");
  });

  test("draft Central rules and fixtures select the expected manifest", () => {
    for (const file of ALWAYS_MFC.concat(GLOB_MFC)) {
      const name = path.basename(file);
      assert.equal(fs.existsSync(path.join(MFC_DRAFT, name)), true, name);
      assert.equal(fs.existsSync(path.join(MFC_FIXTURE, file)), true, file);
    }
    const central = fs.readFileSync(path.join(MFC_DRAFT, "central-project-rules.mdc"), "utf8");
    assert.match(central, /Options API/);
    assert.match(central, /vxceedGrid/);
    assert.doesNotMatch(central, /Document Management System/);
    assert.match(central, /mfc-ejs-/);

    const fuji = rulesService.buildManifest({
      repoRoot: MFC_FIXTURE,
      plannedFiles: ["src/views/Target.vue"],
    });
    assert.deepEqual(fuji.rulesApplied.map((rule) => rule.file).sort(), ALWAYS_MFC.concat(GLOB_MFC).sort());
    for (const file of ALWAYS_MFC) {
      const entry = fuji.rules.find((rule) => rule.file === file);
      assert.equal(entry.reason, "alwaysApply");
    }
    const readmeOnly = rulesService.buildManifest({
      repoRoot: MFC_FIXTURE,
      plannedFiles: ["README.md"],
    });
    assert.deepEqual(readmeOnly.rulesApplied.map((rule) => rule.file).sort(), ALWAYS_MFC.slice().sort());
    for (const file of COMPOSITION_MFC.concat(DOWNSTREAM_MFC)) {
      assert.equal(fuji.rulesApplied.some((rule) => rule.file === file), false, file);
    }
  });

  test("MFC screen docs are always included and gateway skills only for that work", async () => {
    for (const file of COMPOSITION_MFC.concat(DOWNSTREAM_MFC)) {
      const name = path.basename(file);
      const draft = fs.readFileSync(path.join(MFC_DRAFT, name), "utf8");
      const fixture = fs.readFileSync(path.join(MFC_FIXTURE, file), "utf8");
      assert.equal(fixture, draft, name);
    }
    assert.match(fs.readFileSync(path.join(MFC_DRAFT, "DEVELOPER_PROMPT.md"), "utf8"), /Options API only/);
    assert.match(fs.readFileSync(path.join(MFC_DRAFT, "DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md"), "utf8"), /USE_GLOBAL_AUTH/);
    assert.match(
      fs.readFileSync(path.join(MFC_DRAFT, "DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md"), "utf8"),
      /lhu\.central\.access_token/
    );

    const topics = parseProfiles().MFC.rules.topicIncludes;
    assert.deepEqual(
      rulesService.filesForTopics(topics, {
        summary: "Add a column to the outlet grid",
        descriptionText: "Keep Options API.",
      }),
      []
    );
    assert.deepEqual(
      rulesService.filesForTopics(topics, {
        summary: "Fix the global authorization matrix",
        descriptionText: "",
      }),
      []
    );
    assert.deepEqual(
      rulesService.filesForTopics(topics, {
        summary: "Downstream migration onto Global Auth",
        descriptionText: "Ship behind USE_GLOBAL_AUTH.",
      }),
      DOWNSTREAM_MFC
    );

    const screen = await lifecycle.cursorPrompt(
      { id: "promptPlan", type: "cursorPrompt", config: { mode: "plan" } },
      {
        issueKey: "MFC-20",
        profileKey: "MFC",
        jira: {
          key: "MFC-20",
          summary: "Add a column to the outlet grid",
          descriptionText: "Keep Options API. Do not change behavior.",
        },
        analysis: { filesLikelyTouched: ["src/views/Target.vue"] },
        worktreePath: MFC_FIXTURE,
      },
      { runId: "c".repeat(24) }
    );
    for (const file of COMPOSITION_MFC) {
      const entry = screen.rulesManifest.rules.find((rule) => rule.file === file);
      assert.ok(entry, file);
      assert.equal(entry.reason, "forced");
      assert.equal(entry.presentation, "inline");
    }
    for (const file of DOWNSTREAM_MFC) {
      assert.equal(screen.rulesManifest.rules.some((rule) => rule.file === file), false, file);
    }
    assert.match(screen.prompt, /Do NOT add setup\(\)/);
    assert.doesNotMatch(screen.prompt, /migrating Fuji-Vue3/);

    const downstream = await lifecycle.cursorPrompt(
      { id: "promptPlan", type: "cursorPrompt", config: { mode: "plan" } },
      {
        issueKey: "MFC-21",
        profileKey: "MFC",
        jira: {
          key: "MFC-21",
          summary: "Downstream migration onto Global Auth",
          descriptionText: "Ship behind USE_GLOBAL_AUTH and then run the review skill.",
        },
        analysis: { filesLikelyTouched: ["src/router/index.js"] },
        worktreePath: MFC_FIXTURE,
      },
      { runId: "d".repeat(24) }
    );
    for (const file of DOWNSTREAM_MFC) {
      const entry = downstream.rulesManifest.rules.find((rule) => rule.file === file);
      assert.ok(entry, file);
      assert.equal(entry.reason, "forced");
      assert.equal(entry.presentation, "referenced");
    }
    for (const file of COMPOSITION_MFC) {
      const entry = downstream.rulesManifest.rules.find((rule) => rule.file === file);
      assert.ok(entry, file);
      assert.equal(entry.reason, "forced");
    }
    assert.match(downstream.prompt, /DOWNSTREAM_MIGRATION_FRONTEND_SKILL\.md/);
  });

  test("MFC mechanical checks fire on positive fixtures and not on negatives", () => {
    const mfc = rulesChecks.loadChecksFile("Mt-Fuji-Central");
    assert.equal(mfc.enabled, true);
    const cases = [
      {
        id: "no-syncfusion-import",
        file: "src/views/Target.vue",
        positive: "import { Grid } from '@syncfusion/ej2-vue-grids'",
        negative: "import VxceedGrid from '@/components/globalComponents/vxceedGrid.vue'",
      },
      {
        id: "no-ejs-tags",
        file: "src/views/Target.vue",
        positive: "<ejs-grid :dataSource='rows'></ejs-grid>",
        negative: '<vxceed-tabs class="mfc-ejs-tab" :tabs="tabs"></vxceed-tabs>',
      },
      {
        id: "no-v-html",
        file: "src/views/Target.vue",
        positive: '<div v-html="html"></div>',
        negative: "<div>{{ html }}</div>",
      },
      {
        id: "no-console-log",
        file: "src/views/Target.vue",
        positive: 'console.log("debug")',
        negative: 'logger.info("debug")',
      },
      {
        id: "no-localstorage-auth-token",
        file: "src/stores/session.store.js",
        positive: "localStorage.setItem('lhu.central.access_token', token)",
        negative: "localStorage.setItem('lang', 'en-ph')",
      },
      {
        id: "no-extra-sessionstorage-auth-token",
        file: "src/stores/session.store.js",
        positive: "sessionStorage.setItem('refresh_token', token)",
        negative: "sessionStorage.setItem('lhu.central.access_token', token)",
      },
      {
        id: "no-src-lib",
        file: "src/lib/gatewayAuth.js",
        positive: "export function redeem() {}",
        negativeFile: "src/utils/gatewayAuth.js",
        negative: "export function redeem() {}",
      },
      {
        id: "no-src-composables",
        file: "src/composables/useSession.js",
        positive: "export function useSession() {}",
        negativeFile: "src/utils/appContext.js",
        negative: "export function useSession() {}",
      },
      {
        id: "no-vite-env-config",
        file: "src/config/index.js",
        positive: "const gateway = import.meta.env.VITE_GATEWAY_URL",
        negative: "history: createWebHistory(import.meta.env.BASE_URL)",
      },
      {
        id: "no-dist-edits",
        file: "dist/app.js",
        positive: "anything",
        negativeFile: "src/app.js",
        negative: "anything",
      },
    ];
    for (const item of cases) {
      const check = mfc.checks.find((row) => row.id === item.id);
      assert.ok(check, item.id);
      const hit = rulesChecks.runMechanicalChecks({
        files: [{ path: item.file, added: [item.positive] }],
        checks: [check],
      });
      assert.equal(hit.ok, false, item.id);
      const miss = rulesChecks.runMechanicalChecks({
        files: [{ path: item.negativeFile || item.file, added: [item.negative] }],
        checks: [check],
      });
      assert.equal(miss.ok, true, `${item.id} negative`);
    }
  });

  test("retention jobs expire artifacts and worktrees in both directories", async () => {
    const worktrees = path.join(root, "worktrees");
    const playwright = path.join(root, "pw-worktrees");
    const artifacts = path.join(root, "artifacts");
    fs.mkdirSync(worktrees, { recursive: true });
    fs.mkdirSync(playwright, { recursive: true });
    fs.mkdirSync(artifacts, { recursive: true });

    const okId = new mongoose.Types.ObjectId().toString();
    const liveId = new mongoose.Types.ObjectId().toString();
    await Run.create({
      _id: okId,
      jobId: `ok-${okId}`,
      workflowId: new mongoose.Types.ObjectId(),
      status: "success",
      startedAt: new Date(),
      endedAt: new Date(Date.now() - 8 * DAY),
    });
    await Run.create({
      _id: liveId,
      jobId: `live-${liveId}`,
      workflowId: new mongoose.Types.ObjectId(),
      status: "waiting",
      startedAt: new Date(),
    });

    const expiredWt = path.join(worktrees, `${okId}-git1`);
    const liveWt = path.join(worktrees, `${liveId}-git1`);
    const expiredPw = path.join(playwright, `${okId}-pw1`);
    fs.mkdirSync(expiredWt, { recursive: true });
    fs.mkdirSync(liveWt, { recursive: true });
    fs.mkdirSync(expiredPw, { recursive: true });
    fs.writeFileSync(path.join(expiredWt, "keep.txt"), "x");
    fs.writeFileSync(path.join(liveWt, "keep.txt"), "x");
    fs.writeFileSync(path.join(expiredPw, "keep.txt"), "x");

    const publicDir = path.join(artifacts, okId, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, "report.json"), "{}");
    fs.writeFileSync(
      path.join(publicDir, ".meta.json"),
      JSON.stringify({ collectedAt: new Date(Date.now() - 40 * DAY).toISOString() })
    );

    const result = await retention.runRetentionJobs({
      worktreesDir: worktrees,
      playwrightWorktreesDir: playwright,
      root: artifacts,
      publicDays: 30,
      privateDays: 7,
    });
    assert.equal(fs.existsSync(expiredWt), false);
    assert.equal(fs.existsSync(expiredPw), false);
    assert.equal(fs.existsSync(liveWt), true);
    assert.equal(fs.existsSync(publicDir), false);
    assert.ok(result.worktrees.removed.some((item) => item.includes(okId)));
    assert.ok(result.playwright.removed.some((item) => item.includes(okId)));
  });

  test("a large Jira bucket is truncated and a later 429 keeps partial results", async () => {
    const slept = [];
    const pages = [
      {
        issues: [issuePayload("MFC-1"), issuePayload("MFC-2")],
        nextPageToken: "p2",
        isLast: false,
      },
      {
        issues: [issuePayload("MFC-3"), issuePayload("MFC-4")],
        nextPageToken: "p3",
        isLast: false,
      },
      {
        issues: [issuePayload("MFC-5")],
        isLast: true,
      },
    ];
    const http = {
      async post() {
        if (!pages.length) throw new Error("no more pages");
        return { data: pages.shift() };
      },
    };
    const issues = await jira.searchIssues('project = MFC', {
      http,
      sleep: async (ms) => slept.push(ms),
      maxResults: 2,
      maxIssues: 3,
      pageDelayMs: 5,
    });
    assert.deepEqual(
      issues.map((item) => item.key),
      ["MFC-1", "MFC-2", "MFC-3"]
    );
    assert.equal(issues.truncated, true);
    assert.equal(issues.reason, "max_issues");
    assert.equal(issues.pages, 2);
    assert.deepEqual(slept, [5]);

    let searchCalls = 0;
    const partialHttp = {
      async post() {
        searchCalls += 1;
        if (searchCalls === 1) {
          return {
            data: {
              issues: [issuePayload("MF-1"), issuePayload("MF-2")],
              nextPageToken: "p2",
              isLast: false,
            },
          };
        }
        throw rateLimit("1");
      },
    };
    const partial = await jira.searchIssuesDetailed("project = MF", {
      http: partialHttp,
      sleep: async () => {},
      attempts: 2,
      maxResults: 2,
    });
    assert.deepEqual(
      partial.issues.map((item) => item.key),
      ["MF-1", "MF-2"]
    );
    assert.equal(partial.truncated, true);
    assert.equal(partial.reason, "rate_limited");
    assert.ok(searchCalls >= 2);
  });

  test("dispatcher continues other profiles when one bucket is rate limited", async () => {
    await Workflow.create({
      name: "MF pipeline",
      status: "published",
      profileKey: "MF",
      nodes: [{ id: "start", type: "delay", config: { seconds: 0 } }],
      edges: [],
      trigger: { type: "cron", enabled: true, config: { cron: "*/5 * * * *", intake: "bucket", profileKeys: ["MF"] } },
    });
    await Workflow.create({
      name: "MFC pipeline",
      status: "published",
      profileKey: "MFC",
      nodes: [{ id: "start", type: "delay", config: { seconds: 0 } }],
      edges: [],
      trigger: { type: "cron", enabled: true, config: { cron: "*/5 * * * *", intake: "bucket", profileKeys: ["MFC"] } },
    });
    const enqueued = [];
    const http = {
      async post(url, body) {
        const jql = String(body && body.jql);
        if (/project\s*=\s*MFC/i.test(jql)) throw rateLimit("0");
        if (/project\s*=\s*MF\b/i.test(jql)) {
          return { data: { issues: [issuePayload("MF-30")], isLast: true } };
        }
        return { data: { issues: [], isLast: true } };
      },
      async get() {
        throw new Error("unexpected GET");
      },
    };
    const all = parseProfiles();
    const report = await dispatcher.dispatch({
      dryRun: false,
      http,
      sleep: async () => {},
      attempts: 2,
      pageDelayMs: 0,
      maxIssues: 50,
      profiles: { MF: all.MF, MFC: all.MFC },
      recoverStale: async () => ({ released: [], results: [] }),
      enqueue: async (workflowId, input, options) => {
        enqueued.push({ workflowId: String(workflowId), input, options });
        return { id: options && options.jobId };
      },
    });
    const mf = report.profiles.find((row) => row.jiraKey === "MF");
    const mfc = report.profiles.find((row) => row.jiraKey === "MFC");
    assert.ok(mf);
    assert.ok(mfc);
    assert.equal(mfc.rateLimited, true);
    assert.equal(mf.started.length, 1);
    assert.equal(mf.started[0].jiraKey, "MF-30");
    assert.equal(enqueued.length, 1);
  });

  test("leftover processes from a crashed worker are killed; live waits are not", async () => {
    const failedChild = spawnSleeper();
    const liveChild = spawnSleeper();
    const waitChild = spawnSleeper();
    await waitAlive(failedChild.pid);
    await waitAlive(liveChild.pid);
    await waitAlive(waitChild.pid);

    const failed = await Run.create({
      jobId: "phase11-failed",
      status: "failed",
      startedAt: new Date(),
      endedAt: new Date(),
      external: { processes: [{ pid: failedChild.pid, startedAt: new Date(), role: "vite" }] },
    });
    const live = await Run.create({
      jobId: "phase11-live",
      status: "running",
      executionClaim: "token-live",
      executionClaimExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      startedAt: new Date(),
      external: { processes: [{ pid: liveChild.pid, startedAt: new Date(), role: "vite" }] },
    });
    const waiting = await Run.create({
      jobId: "phase11-waiting",
      status: "waiting",
      startedAt: new Date(),
      wait: { kind: "playwright", state: "pending" },
      external: { processes: [{ pid: waitChild.pid, startedAt: new Date(), role: "playwright" }] },
    });
    const expiredChild = spawnSleeper();
    await waitAlive(expiredChild.pid);
    const expired = await Run.create({
      jobId: "phase11-expired",
      status: "running",
      executionClaim: "token-expired",
      executionClaimExpiresAt: new Date(Date.now() - 1000),
      startedAt: new Date(),
      external: { processes: [{ pid: expiredChild.pid, startedAt: new Date(), role: "agent" }] },
    });

    const result = await recovery.cleanupLeftoverProcesses();
    await waitDead(failedChild.pid);
    await waitDead(expiredChild.pid);
    assert.equal(await isAlive(liveChild.pid), true);
    assert.equal(await isAlive(waitChild.pid), true);
    assert.ok(result.killed.some((item) => item.pid === failedChild.pid));
    assert.ok(result.killed.some((item) => item.pid === expiredChild.pid));
    assert.ok(result.skipped.includes(String(live._id)));
    assert.ok(result.skipped.includes(String(waiting._id)));

    const failedRow = await Run.findById(failed._id).lean();
    const expiredRow = await Run.findById(expired._id).lean();
    const liveRow = await Run.findById(live._id).lean();
    const waitingRow = await Run.findById(waiting._id).lean();
    assert.equal((failedRow.external.processes || []).length, 0);
    assert.equal((expiredRow.external.processes || []).length, 0);
    assert.equal(liveRow.external.processes[0].pid, liveChild.pid);
    assert.equal(waitingRow.external.processes[0].pid, waitChild.pid);

    liveChild.kill("SIGKILL");
    waitChild.kill("SIGKILL");
    await waitDead(liveChild.pid);
    await waitDead(waitChild.pid);
  });

  test("root implementation.md points at the Jira-to-PR plan", () => {
    const text = fs.readFileSync(ROOT_IMPL, "utf8");
    assert.match(text, /docs\/jira-pr-automation\/implementation\.md/);
  });
});
