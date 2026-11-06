const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Run = require("../src/models/Run");
const git = require("../src/services/gitService");
const testSelect = require("../src/services/testSelect");
const playwrightReport = require("../src/services/playwrightReport");
const artifactRedactor = require("../src/services/artifactRedactor");
const baseline = require("../src/services/baseline");
const failureClassification = require("../src/services/failureClassification");
const lifecycle = require("../src/nodes/lifecycle");
const { handlePlaywrightJob } = require("../src/services/playwrightAttempt");
const { parseProfiles } = require("../src/services/projectRegistry");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
} = require("../test-support/helpers");

const QUT_REPORT = path.join(__dirname, "fixtures", "playwright", "qut-report.json");
const TAC_REPORT = path.join(__dirname, "fixtures", "playwright", "tac-report.json");
const QUT_E2E = "D:/Projects/vxc-ui-automation/tests/e2e";
const DAY = 24 * 60 * 60 * 1000;

const MF_MAP = {
  rules: [{ match: "src/views/LoadOut.vue", modules: ["Load Out"] }],
  autoKebabFromViews: true,
  sharedPaths: [
    "src/router/**",
    "src/stores/**",
    "src/components/globalComponents/**",
    "package.json",
  ],
  sharedFallback: ["-g", "@sanity"],
};

const EXISTING = ["Load Out", "stock-transfer", "home", "login"];

function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `git exited ${code}`));
    });
  });
}

async function initRepo(dir, content) {
  await fs.promises.mkdir(dir, { recursive: true });
  await gitExec(["init", "-b", "main"], dir);
  await gitExec(["config", "user.email", "test@example.com"], dir);
  await gitExec(["config", "user.name", "Test"], dir);
  await fs.promises.writeFile(path.join(dir, "README.md"), content);
  await gitExec(["add", "README.md"], dir);
  await gitExec(["commit", "-m", "init"], dir);
}

describe("jira-pr phase 8 test selection, reports and failure handling", () => {
  let root;
  let previousArtifacts;

  before(async () => {
    await connectTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase8-"));
    previousArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = path.join(root, "artifacts");
    fs.mkdirSync(process.env.ARTIFACTS_DIR, { recursive: true });
  });

  after(async () => {
    if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousArtifacts;
    await disconnectTestDb();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(async () => {
    await clearTestData();
  });

  test("module mapping includes folders with spaces such as Load Out", () => {
    const selected = testSelect.selectAppTests({
      changedFiles: ["src/views/LoadOut.vue"],
      moduleMap: MF_MAP,
      existingModules: EXISTING,
      moduleRoot: "tests/e2e",
    });
    assert.equal(selected.fallback, false);
    assert.deepEqual(selected.selectedModules, ["Load Out"]);
    assert.deepEqual(selected.selectedPaths, ["tests/e2e/Load Out"]);
    assert.deepEqual(selected.unmappedFiles, []);
  });

  test("kebab-case of a view maps to an existing e2e folder", () => {
    const selected = testSelect.selectAppTests({
      changedFiles: ["src/views/StockTransfer.vue"],
      moduleMap: MF_MAP,
      existingModules: EXISTING,
      moduleRoot: "tests/e2e",
    });
    assert.equal(selected.fallback, false);
    assert.deepEqual(selected.selectedModules, ["stock-transfer"]);
    assert.deepEqual(selected.selectedPaths, ["tests/e2e/stock-transfer"]);
  });

  test("the shared-path fallback replaces module filters", () => {
    const selected = testSelect.selectAppTests({
      changedFiles: ["src/views/StockTransfer.vue", "src/router/index.js"],
      moduleMap: MF_MAP,
      existingModules: EXISTING,
      moduleRoot: "tests/e2e",
    });
    assert.equal(selected.fallback, true);
    assert.equal(selected.reason, "shared-path");
    assert.deepEqual(selected.selectedModules, ["stock-transfer"]);
    assert.deepEqual(selected.selectedPaths, ["-g", "@sanity"]);
  });

  test("unmapped files are listed and force the fallback", () => {
    const selected = testSelect.selectAppTests({
      changedFiles: ["src/views/StockTransfer.vue", "src/utils/format.js"],
      moduleMap: MF_MAP,
      existingModules: EXISTING,
      moduleRoot: "tests/e2e",
    });
    assert.equal(selected.fallback, true);
    assert.equal(selected.reason, "unmapped");
    assert.deepEqual(selected.unmappedFiles, ["src/utils/format.js"]);
    assert.deepEqual(selected.selectedPaths, ["-g", "@sanity"]);
    assert.ok(selected.selectedModules.includes("stock-transfer"));
  });

  test("tag extraction from an automation summary selects specs and grep", () => {
    const tags = testSelect.extractTags("Script [@TAC-3-2] for load out");
    assert.deepEqual(tags, ["@TAC-3-2"]);
    const selected = testSelect.selectAutomationTests({
      changedFiles: [
        "tests/e2e/login/login.spec.ts",
        "src/helpers/wait.ts",
      ],
      summary: "Add [@TAC-3-2] login coverage",
    });
    assert.equal(selected.fallback, false);
    assert.equal(selected.reason, "specs-and-tags");
    assert.deepEqual(selected.tags, ["@TAC-3-2"]);
    assert.deepEqual(selected.selectedPaths, [
      "tests/e2e/login/login.spec.ts",
      "-g",
      "@TAC-3-2",
    ]);
    assert.deepEqual(selected.unmappedFiles, ["src/helpers/wait.ts"]);
  });

  test("playwrightNode appends the selection to testCommand", () => {
    const command = testSelect.appendSelection(["node", "scripts/playwright-test.js"], {
      selectedPaths: ["tests/e2e/stock-transfer"],
    });
    assert.deepEqual(command, ["node", "scripts/playwright-test.js", "tests/e2e/stock-transfer"]);
    const sanity = testSelect.appendSelection(["node", "scripts/playwright-test.js"], {
      selectedPaths: ["-g", "@sanity"],
    });
    assert.deepEqual(sanity, ["node", "scripts/playwright-test.js", "-g", "@sanity"]);
  });

  test("testSelect node writes selection onto the payload", async () => {
    const out = await lifecycle.testSelect(
      { id: "select", type: "testSelect", config: { mode: "app" } },
      {
        changedFiles: ["src/views/LoadOut.vue"],
        existingModules: EXISTING,
        moduleMap: MF_MAP,
        profileKey: "MF",
      },
      { runId: new mongoose.Types.ObjectId().toString() }
    );
    assert.equal(out.branch, "true");
    assert.deepEqual(out.selection.selectedModules, ["Load Out"]);
    assert.deepEqual(out.selection.selectedPaths, ["tests/e2e/Load Out"]);
  });

  test("report parsing with real report.json samples from both repos", () => {
    const qut = playwrightReport.parseReportFile(QUT_REPORT);
    assert.equal(qut.counts.passed, 1);
    assert.equal(qut.counts.failed, 1);
    assert.equal(qut.counts.flaky, 1);
    assert.equal(qut.failures.length, 1);
    assert.equal(qut.failures[0].title.includes("shows quantity validation"), true);
    assert.match(qut.failures[0].file, /stock-transfer/);
    assert.match(qut.failures[0].error, /Timeout 30000ms/);
    assert.equal(qut.failures[0].tracePath.endsWith("trace.zip"), true);
    assert.equal(qut.failures[0].step, "Click Save");
    assert.equal(qut.flaky.length, 1);

    const tac = playwrightReport.parseReportFile(TAC_REPORT);
    assert.equal(tac.counts.passed, 1);
    assert.equal(tac.counts.failed, 1);
    assert.equal(tac.counts.flaky, 0);
    assert.match(tac.failures[0].file, /login/);
    assert.equal(tac.passed[0].title.includes("[@TAC-3-2]"), true);
  });

  test("redaction copies text to public and traces to private", async () => {
    const secret = "super-secret-env-token-phase8";
    const testCwd = path.join(root, "suite");
    const results = path.join(testCwd, "test-results");
    fs.mkdirSync(path.join(results, "stock-transfer-validation"), { recursive: true });
    fs.writeFileSync(
      path.join(testCwd, ".env"),
      `API_TOKEN=${secret}\nBASE_URL=http://localhost:5182\n`
    );
    fs.writeFileSync(
      path.join(results, "report.json"),
      JSON.stringify({ token: secret, ok: true, cookie: "Authorization: Bearer abc.def" })
    );
    fs.writeFileSync(path.join(results, "stock-transfer-validation", "trace.zip"), "trace-bytes");
    fs.writeFileSync(path.join(results, "stock-transfer-validation", "test-failed-1.png"), "png");
    const runId = new mongoose.Types.ObjectId().toString();
    const collected = await artifactRedactor.collectAttempt({
      runId,
      attempt: 1,
      testCwd,
    });
    assert.equal(collected.skipped, false);
    const publicReport = fs.readFileSync(
      path.join(collected.publicDir, "test-results", "report.json"),
      "utf8"
    );
    assert.equal(publicReport.includes(secret), false);
    assert.match(publicReport, /\[redacted\]/);
    assert.equal(
      fs.existsSync(path.join(collected.publicDir, "test-results", "stock-transfer-validation", "trace.zip")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(collected.privateDir, "test-results", "stock-transfer-validation", "trace.zip")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(collected.privateDir, "test-results", "stock-transfer-validation", "test-failed-1.png")),
      true
    );
  });

  test("the baseline comparison table", () => {
    const changed = {
      passed: [
        {
          title: "creates a stock transfer",
          file: "tests/e2e/stock-transfer/stock-transfer.spec.ts",
        },
      ],
      failures: [
        {
          title: "home is slow",
          file: "tests/e2e/home/home.spec.ts",
          error: "Timeout on dashboard",
          step: "Open home",
        },
        {
          title: "save fails",
          file: "tests/e2e/stock-transfer/stock-transfer.spec.ts",
          error: "button missing",
          step: "Click Save",
        },
        {
          title: "other error",
          file: "tests/e2e/lists-branding/list.spec.ts",
          error: "new boom",
          step: "Click",
        },
      ],
      flaky: [],
    };
    const baseReport = {
      passed: [
        {
          title: "save fails",
          file: "tests/e2e/stock-transfer/stock-transfer.spec.ts",
        },
      ],
      failures: [
        {
          title: "home is slow",
          file: "tests/e2e/home/home.spec.ts",
          error: "Timeout on dashboard",
          step: "Open home",
        },
        {
          title: "other error",
          file: "tests/e2e/lists-branding/list.spec.ts",
          error: "old boom",
          step: "Click",
        },
      ],
      flaky: [],
    };
    const cfg = {
      envHash: "abc",
      authHash: "def",
      baseUrlScheme: "http",
      args: ["-g", "home"],
      ci: "1",
      workers: 4,
      browserVersion: "1.48.2",
      playwrightProject: "chromium",
    };
    const selection = { selectedModules: ["stock-transfer"], selectedPaths: ["tests/e2e/stock-transfer"] };
    const table = baseline.compareBaseline({
      changed,
      baseline: baseReport,
      changedConfig: cfg,
      baselineConfig: cfg,
      selection,
      changedFiles: ["src/views/StockTransfer.vue"],
    });
    const byTitle = Object.fromEntries(table.rows.map((row) => [row.title, row]));
    assert.equal(byTitle["save fails"].meaning, "regression");
    assert.equal(byTitle["save fails"].blocks, true);
    assert.equal(byTitle["home is slow"].meaning, "pre-existing");
    assert.equal(byTitle["home is slow"].blocks, false);
    assert.equal(byTitle["other error"].meaning, "regression");
    assert.equal(table.summary.regressions, 2);
    assert.equal(table.summary.preexisting, 1);
    assert.equal(table.blocks, true);
    assert.equal(table.ownScenarioPassed, false);

    const outsideOnly = baseline.compareBaseline({
      changed: {
        passed: changed.passed,
        failures: [changed.failures[0]],
        flaky: [],
      },
      baseline: baseReport,
      changedConfig: cfg,
      baselineConfig: cfg,
      selection,
      changedFiles: ["src/views/StockTransfer.vue"],
    });
    assert.equal(outsideOnly.blocks, false);
    assert.equal(outsideOnly.ownScenarioPassed, true);
    assert.equal(outsideOnly.rows[0].meaning, "pre-existing");

    const mismatch = baseline.compareBaseline({
      changed,
      baseline: baseReport,
      changedConfig: cfg,
      baselineConfig: { ...cfg, envHash: "other" },
      selection,
      changedFiles: [],
    });
    assert.equal(mismatch.inconclusive, true);
    assert.equal(mismatch.blocks, true);
    assert.equal(mismatch.reason, "envHash");
  });

  test("a baseline failure inside the ticket modules still blocks", () => {
    const failure = {
      title: "creates a stock transfer",
      file: "tests/e2e/stock-transfer/stock-transfer.spec.ts",
      error: "same",
      step: "Save",
    };
    const cfg = {
      envHash: "a",
      authHash: "b",
      baseUrlScheme: "http",
      args: [],
      ci: "1",
      workers: 1,
      browserVersion: "1",
      playwrightProject: "",
    };
    const table = baseline.compareBaseline({
      changed: { passed: [], failures: [failure], flaky: [] },
      baseline: { passed: [], failures: [failure], flaky: [] },
      changedConfig: cfg,
      baselineConfig: cfg,
      selection: { selectedModules: ["stock-transfer"] },
      changedFiles: [],
    });
    assert.equal(table.rows[0].meaning, "pre-existing");
    assert.equal(table.rows[0].blocks, true);
    assert.equal(table.blocks, true);
  });

  test("each classification's routing", () => {
    const cases = [
      ["app-bug", "app", "fix_app", true, "playwright_failed"],
      ["app-bug", "automation", "report_and_block", false, "app_bug_blocked"],
      ["script-bug", "app", "linked_automation_run", true, "playwright_failed"],
      ["script-bug", "automation", "fix_script", true, "playwright_failed"],
      ["test-outdated", "app", "linked_automation_run", true, "playwright_failed"],
      ["test-outdated", "automation", "fix_script", true, "playwright_failed"],
      ["env", "app", "stop_env", false, "env_failed"],
      ["env", "automation", "stop_env", false, "env_failed"],
      ["data-issue", "app", "stop_unknown", false, "playwright_failed"],
      ["unknown", "automation", "stop_unknown", false, "playwright_failed"],
    ];
    for (const [classification, kind, action, retryable, notify] of cases) {
      const routed = failureClassification.routeFailure({ classification, kind });
      assert.equal(routed.action, action, `${classification}/${kind} action`);
      assert.equal(routed.retryable, retryable, `${classification}/${kind} retryable`);
      assert.equal(routed.notify, notify, `${classification}/${kind} notify`);
      assert.equal(routed.block, true);
    }
    const invalid = failureClassification.normalize({ classification: "nope" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.value.classification, "unknown");
    const envFromPlaywright = failureClassification.fromPlaywrightOutcome({
      failureClass: "timeout",
      reason: "timed-out",
    });
    assert.equal(envFromPlaywright.value.classification, "env");
  });

  test("artifact retention keeps failed runs and expires completed ones", async () => {
    const okId = new mongoose.Types.ObjectId().toString();
    const failId = new mongoose.Types.ObjectId().toString();
    await Run.create({
      _id: okId,
      jobId: `ok-${okId}`,
      workflowId: new mongoose.Types.ObjectId(),
      status: "success",
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await Run.create({
      _id: failId,
      jobId: `fail-${failId}`,
      workflowId: new mongoose.Types.ObjectId(),
      status: "failed",
      startedAt: new Date(),
      endedAt: new Date(),
    });
    const okPublic = path.join(process.env.ARTIFACTS_DIR, okId, "public");
    const okPrivate = path.join(process.env.ARTIFACTS_DIR, okId, "private");
    const failPublic = path.join(process.env.ARTIFACTS_DIR, failId, "public");
    fs.mkdirSync(okPublic, { recursive: true });
    fs.mkdirSync(okPrivate, { recursive: true });
    fs.mkdirSync(failPublic, { recursive: true });
    fs.writeFileSync(path.join(okPublic, "report.json"), "{}");
    fs.writeFileSync(path.join(okPrivate, "trace.zip"), "z");
    fs.writeFileSync(path.join(failPublic, "report.json"), "{}");
    const oldPublic = new Date(Date.now() - 40 * DAY).toISOString();
    const oldPrivate = new Date(Date.now() - 10 * DAY).toISOString();
    fs.writeFileSync(path.join(okPublic, ".meta.json"), JSON.stringify({ collectedAt: oldPublic }));
    fs.writeFileSync(path.join(okPrivate, ".meta.json"), JSON.stringify({ collectedAt: oldPrivate }));
    fs.writeFileSync(
      path.join(failPublic, ".meta.json"),
      JSON.stringify({ collectedAt: oldPublic })
    );
    const result = await artifactRedactor.reconcileArtifacts({
      root: process.env.ARTIFACTS_DIR,
      publicDays: 30,
      privateDays: 7,
    });
    assert.equal(fs.existsSync(okPublic), false);
    assert.equal(fs.existsSync(okPrivate), false);
    assert.equal(fs.existsSync(failPublic), true);
    assert.ok(result.removed.some((item) => item.includes(okId)));
  });

  test("handlePlaywrightJob passes selection into the suite command and records the report", async () => {
    const dest = path.join(root, "pw-select");
    await initRepo(dest, "lock\n");
    await fs.promises.writeFile(path.join(dest, "package-lock.json"), "{}");
    await fs.promises.mkdir(path.join(dest, "test-results"), { recursive: true });
    await fs.promises.copyFile(QUT_REPORT, path.join(dest, "test-results", "report.json"));
    const sha = await git.revParse(dest);
    const settled = [];
    const commands = [];
    await handlePlaywrightJob(
      {
        data: {
          runId: new mongoose.Types.ObjectId().toString(),
          nodeId: "pw",
          strategy: "in-repo",
          target: "local-worktree",
          testedSha: sha,
          appWorktree: dest,
          testWorktree: dest,
          testCommand: ["node", "scripts/playwright-test.js"],
          selection: { selectedPaths: ["tests/e2e/stock-transfer"] },
        },
      },
      {
        enqueueSettle: async (payload) => settled.push(payload),
        runSuite: async (opts) => {
          commands.push(opts.command);
          return { code: 1, reportPresent: true, stdout: "", stderr: "" };
        },
      }
    );
    assert.deepEqual(commands[0], ["node", "scripts/playwright-test.js", "tests/e2e/stock-transfer"]);
    assert.equal(settled[0].result.reportPresent, true);
    assert.equal(settled[0].result.report.counts.failed, 1);
    assert.equal(settled[0].result.branch, "false");
  });

  test("Load Out and stock-transfer map against the real automation repo when present", () => {
    if (!fs.existsSync(QUT_E2E)) return;
    const existing = testSelect.listModuleFolders(QUT_E2E);
    const profiles = parseProfiles();
    const loadOut = testSelect.selectAppTests({
      changedFiles: ["src/views/LoadOut.vue"],
      moduleMap: profiles.MF.moduleMap,
      existingModules: existing,
      moduleRoot: profiles.QUT.repo.moduleRoot,
    });
    assert.equal(loadOut.fallback, false);
    assert.ok(loadOut.selectedModules.includes("Load Out"));
    const stock = testSelect.selectAppTests({
      changedFiles: ["src/views/StockTransfer.vue"],
      moduleMap: profiles.MF.moduleMap,
      existingModules: existing,
      moduleRoot: profiles.QUT.repo.moduleRoot,
    });
    assert.ok(stock.selectedPaths.some((part) => String(part).includes("stock-transfer")));
  });
});
