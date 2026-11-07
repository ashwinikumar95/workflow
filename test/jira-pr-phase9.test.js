const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const Workflow = require("../src/models/workflow");
const git = require("../src/services/gitService");
const github = require("../src/services/githubPrService");
const lifecycle = require("../src/nodes/lifecycle");
const { parseProfiles } = require("../src/services/projectRegistry");
const { validateWorkflowGraph } = require("../src/utils/workflowGraph");
const {
  loadTemplate,
  buildProjectWorkflow,
  everyTerminalPathHasNotify,
  notifyThenJiraOnStops,
} = require("../src/services/workflowTemplate");
const {
  isForbiddenPath,
  assertCommitPushGuard,
} = require("../src/services/commitPushGuard");
const { buildPrBody, buildPrTitle } = require("../src/services/prBody");
const { connectTestDb, disconnectTestDb, clearTestData } = require("../test-support/helpers");

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

async function commitFile(dir, rel, content, message) {
  const full = path.join(dir, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, content);
  await gitExec(["add", "-f", rel], dir);
  await gitExec(["commit", "-m", message], dir);
}

function stubProfile(extra = {}) {
  return {
    jiraKey: "MF",
    kind: "app",
    linkedProfile: "QUT",
    enabled: true,
    repo: {
      location: "D:/tmp/app",
      defaultBranch: "main",
      github: { owner: "Vxceed-IN", repo: "Fuji-Vue3" },
      credentialRef: "GITHUB_TOKEN",
      credentialFiles: [".env"],
      appCommand: ["npx", "vite", "--port", "5182", "--strictPort"],
      readiness: "/",
      testCommand: [],
    },
    agent: { model: "composer-2.5", maxFixAttempts: 2 },
    ...extra,
  };
}

function stubLinked(extra = {}) {
  return {
    jiraKey: "QUT",
    kind: "automation",
    linkedProfile: "MF",
    enabled: true,
    repo: {
      location: "D:/tmp/auto",
      defaultBranch: "main",
      github: { owner: "Vxceed-IN", repo: "vxc-ui-automation" },
      credentialRef: "GITHUB_TOKEN",
      credentialFiles: [".env", "playwright/.auth"],
      appCommand: [],
      readiness: "",
      testCommand: ["node", "scripts/playwright-test.js"],
    },
    agent: { model: "composer-2.5", maxFixAttempts: 3 },
    ...extra,
  };
}

describe("jira-pr phase 9 templates, PRs and commit guard", () => {
  let root;
  let repo;
  let worktrees;
  let previousWorktrees;

  before(async () => {
    await connectTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase9-"));
    repo = path.join(root, "app");
    worktrees = path.join(root, "worktrees");
    await fs.promises.mkdir(worktrees);
    await initRepo(repo, "app\n");
    previousWorktrees = process.env.WORKTREES_DIR;
    process.env.WORKTREES_DIR = worktrees;
  });

  after(async () => {
    git.setGitRunner(null);
    if (previousWorktrees === undefined) delete process.env.WORKTREES_DIR;
    else process.env.WORKTREES_DIR = previousWorktrees;
    await disconnectTestDb();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(async () => {
    await clearTestData();
    git.setGitRunner(null);
  });

  test("the app-ticket template unrolls maxFixAttempts times", () => {
    const template = loadTemplate("app-ticket");
    assert.equal(template.kind, "app-ticket");
    const two = buildProjectWorkflow(stubProfile({ agent: { model: "x", maxFixAttempts: 2 } }), stubLinked());
    const three = buildProjectWorkflow(stubProfile({ agent: { model: "x", maxFixAttempts: 3 } }), stubLinked());
    const fixAgents = (graph, role) =>
      graph.nodes.filter(
        (node) =>
          node.type === "cursorAgent" &&
          node.config &&
          node.config.mode === "fix" &&
          node.config.role === role
      );
    const playwrights = (graph, role) =>
      graph.nodes.filter((node) => node.type === "playwright" && node.config && node.config.role === role);
    assert.equal(fixAgents(two, "app").length, 2);
    assert.equal(playwrights(two, "app").length, 3);
    assert.equal(fixAgents(three, "app").length, 3);
    assert.equal(playwrights(three, "app").length, 4);
    assert.equal(two.runtime, "host");
    assert.equal(two.retention.keepWorktreeOnFailure, true);
    assert.equal(two.nodes.find((node) => node.type === "githubPr").config.retries, 1);
  });

  test("every terminal path has a notify node then jiraUpdate", () => {
    const graph = buildProjectWorkflow(stubProfile(), stubLinked());
    assert.equal(everyTerminalPathHasNotify(graph.nodes, graph.edges), true);
    assert.equal(notifyThenJiraOnStops(graph.nodes, graph.edges), true);
    const check = validateWorkflowGraph(graph);
    assert.equal(check.ok, true, check.message);
  });

  test("failure jira stops comment without moving the ticket off In Progress", () => {
    const graph = buildProjectWorkflow(stubProfile(), stubLinked());
    const stops = graph.nodes.filter(
      (node) => node.type === "jiraUpdate" && node.id !== "claim" && node.id !== "jiraReview"
    );
    assert.ok(stops.length > 0);
    for (const node of stops) {
      assert.equal(node.config.transition, undefined, node.id);
      assert.ok(String(node.config.comment || "").trim(), node.id);
    }
    assert.equal(graph.nodes.find((node) => node.id === "claim").config.transition, "claim");
    assert.equal(graph.nodes.find((node) => node.id === "jiraReview").config.transition, "review");
  });

  test("MF profile generates a valid published graph", () => {
    const profiles = parseProfiles();
    const graph = buildProjectWorkflow(profiles.MF, profiles.QUT);
    const check = validateWorkflowGraph(graph);
    assert.equal(check.ok, true, check.message);
    assert.equal(graph.profileKey, "MF");
    assert.equal(graph.repository.location, profiles.MF.repo.location);
    const appPr = graph.nodes.find((node) => node.type === "githubPr" && node.config && node.config.role === "app");
    assert.equal(appPr.config.repository.repo, "Fuji-Vue3");
  });

  test("the guard catches each forbidden file and secret line", async () => {
    assert.equal(isForbiddenPath(".env"), true);
    assert.equal(isForbiddenPath(".env.local"), true);
    assert.equal(isForbiddenPath(".env.example"), false);
    assert.equal(isForbiddenPath("playwright/.auth/user1.json"), true);
    assert.equal(isForbiddenPath("certs/app.pem"), true);
    assert.equal(isForbiddenPath("src/id_rsa.key"), true);

    const base = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await fs.promises.writeFile(path.join(repo, ".env"), "SECRET_TOKEN=super-secret-value\n");
    const untrackedEnv = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: base,
      sourceRepoPath: path.join(root, "missing-source"),
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(untrackedEnv.ok, false);
    assert.ok(untrackedEnv.errors.some((row) => row.file === ".env"));

    await commitFile(repo, ".env", "SECRET_TOKEN=super-secret-value\n", "add env");
    const committedEnv = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: base,
      sourceRepoPath: path.join(root, "missing-source"),
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(committedEnv.ok, false);
    assert.equal(committedEnv.reason, "env");
    assert.ok(committedEnv.errors.some((row) => row.file === ".env"));
    assert.equal(JSON.stringify(committedEnv).includes("super-secret-value"), false);

    const afterEnv = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await gitExec(["rm", "-f", ".env"], repo);
    await gitExec(["commit", "-m", "remove env"], repo);

    await commitFile(repo, ".env.local", "x=1\n", "add env local");
    const localHit = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: afterEnv,
      sourceRepoPath: repo,
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(localHit.ok, false);
    assert.ok(localHit.errors.some((row) => row.file === ".env.local"));
    await gitExec(["rm", "-f", ".env.local"], repo);
    await gitExec(["commit", "-m", "remove env local"], repo);

    const afterLocal = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await commitFile(repo, ".env.example", "SECRET_TOKEN=\n", "example ok");
    const exampleOk = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: afterLocal,
      sourceRepoPath: repo,
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(exampleOk.ok, true);

    const afterExample = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await commitFile(repo, "playwright/.auth/user.json", "{\"cookie\":\"abc\"}\n", "auth");
    const authHit = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: afterExample,
      sourceRepoPath: repo,
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(authHit.ok, false);
    assert.ok(authHit.errors.some((row) => row.file.startsWith("playwright/.auth/")));
    await gitExec(["rm", "-rf", "playwright"], repo);
    await gitExec(["add", "-A"], repo);
    await gitExec(["commit", "-m", "remove auth"], repo);

    const afterAuth = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await commitFile(repo, "certs/app.pem", "-----BEGIN CERT-----\n", "pem");
    const pemHit = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: afterAuth,
      sourceRepoPath: repo,
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(pemHit.ok, false);
    assert.ok(pemHit.errors.some((row) => row.file === "certs/app.pem"));
    await gitExec(["rm", "-rf", "certs"], repo);
    await gitExec(["add", "-A"], repo);
    await gitExec(["commit", "-m", "remove pem"], repo);

    const afterPem = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await commitFile(repo, ".gitignore", ".env\nplaywright/.auth/\n", "ignore secrets");
    const afterIgnore = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await fs.promises.writeFile(path.join(repo, ".env"), "SECRET_TOKEN=super-secret-value\n");
    await commitFile(repo, "src/leak.js", "const x = \"super-secret-value\";\n", "leak");
    const leak = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: afterIgnore,
      sourceRepoPath: repo,
      credentialFiles: [".env"],
      stage: "push",
    });
    assert.equal(leak.ok, false);
    assert.ok(leak.errors.some((row) => row.kind === "secret-line" && row.file === "src/leak.js"));
    assert.equal(String(leak.summary).includes("super-secret-value"), false);

    await gitExec(["rm", "-f", "src/leak.js"], repo);
    await gitExec(["add", "-A"], repo);
    await gitExec(["commit", "-m", "cleanup leak"], repo);
    const afterLeak = (await git.runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await fs.promises.mkdir(path.join(repo, "playwright", ".auth"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "playwright", ".auth", "user.json"), "{\"cookie\":\"rewritten\"}\n");
    const authRewrite = await assertCommitPushGuard({
      worktreePath: repo,
      baseSha: afterLeak,
      sourceRepoPath: repo,
      credentialFiles: [".env", "playwright/.auth"],
      stage: "push",
    });
    assert.equal(authRewrite.ok, true);
  });

  test("a retried PR step finds the existing PR and keeps a full body", async () => {
    process.env.PHASE9_GITHUB_TOKEN = "phase9-token";
    const original = github.openPullRequest;
    const seen = [];
    github.openPullRequest = async (args) => {
      seen.push(args);
      if (seen.length === 1) return "https://github.com/Vxceed-IN/Fuji-Vue3/pull/11";
      return "https://github.com/Vxceed-IN/Fuji-Vue3/pull/11";
    };
    git.setGitRunner(async (args) => {
      if (args.includes("rev-parse")) return { stdout: "abc123\n", stderr: "", code: 0 };
      if (args.includes("get-url")) {
        return { stdout: "https://github.com/Vxceed-IN/Fuji-Vue3.git\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const saved = [];
    const runState = {
      runId: new (require("mongoose").Types.ObjectId)().toString(),
      predecessorId: "pw",
      workflow: { repository: { defaultBranch: "main", credentialRef: "GITHUB_TOKEN" } },
      external: {
        repos: {
          app: {
            testedSha: "abc123",
            branch: "wf/MF-9/aaaaaaaaaaaaaaaaaaaaaaaa",
            worktreePath: path.join(worktrees, "missing-app"),
            repoPath: repo,
            preAgentSha: "base123",
            playwrightByNode: {
              pw: { status: "passed", reportPresent: true, testedSha: "abc123" },
            },
          },
        },
      },
      checkpointExternal: async (patch) => {
        saved.push(patch);
      },
    };
    const input = {
      jira: { key: "MF-9", summary: "Fix the form" },
      plan: { approach: "Change the form", filesToChange: ["src/Form.vue"], rulesApplied: ["security-rules.mdc"] },
      rulesApplied: ["security-rules.mdc"],
      deviations: [],
      rulesChecks: { ok: true, violations: [] },
      selection: { selectedModules: ["home"], selectedPaths: ["tests/e2e/home"] },
      playwrightReport: { counts: { passed: 3, failed: 0, flaky: 0 } },
    };
    try {
      const first = await lifecycle.githubPr(
        {
          config: {
            role: "app",
            retries: 1,
            repository: {
              owner: "Vxceed-IN",
              repo: "Fuji-Vue3",
              defaultBranch: "main",
              credentialRef: "PHASE9_GITHUB_TOKEN",
            },
          },
        },
        input,
        runState
      );
      const second = await lifecycle.githubPr(
        {
          config: {
            role: "app",
            retries: 1,
            repository: {
              owner: "Vxceed-IN",
              repo: "Fuji-Vue3",
              defaultBranch: "main",
              credentialRef: "PHASE9_GITHUB_TOKEN",
            },
          },
        },
        input,
        runState
      );
      assert.equal(first.prUrl, "https://github.com/Vxceed-IN/Fuji-Vue3/pull/11");
      assert.equal(second.prUrl, first.prUrl);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].body.includes("https://"), true);
      assert.match(seen[0].body, /MF-9/);
      assert.match(seen[0].body, /Change the form/);
      assert.match(seen[0].body, /security-rules.mdc/);
      assert.match(seen[0].body, /Passed: 3/);
      assert.equal(saved.some((patch) => patch.repos && patch.repos.app && patch.repos.app.prUrl), true);
      assert.equal(first.branch, "true");
    } finally {
      github.openPullRequest = original;
      git.setGitRunner(null);
      delete process.env.PHASE9_GITHUB_TOKEN;
    }
  });

  test("PR title and body stay structured and redacted", () => {
    const title = buildPrTitle({ jira: { key: "MF-9", summary: "Fix the form" } }, "branch");
    assert.equal(title, "MF-9: Fix the form");
    const body = buildPrBody({
      jira: { key: "MF-9", summary: "Fix the form" },
      plan: { approach: "Narrow change", filesToChange: ["a.js"], rulesApplied: ["dms-project-rules.mdc"] },
      deviations: ["approved grid"],
      rulesChecks: { ok: false, violations: [{ file: "a.js", detail: "console.log" }] },
      selection: { selectedModules: ["home"], selectedPaths: ["tests/e2e/home"] },
      playwrightReport: { counts: { passed: 1, failed: 0, flaky: 0 } },
      linkedPrUrl: "https://github.com/Vxceed-IN/vxc-ui-automation/pull/2",
    });
    assert.match(body, /Narrow change/);
    assert.match(body, /dms-project-rules.mdc/);
    assert.match(body, /approved grid/);
    assert.match(body, /console\.log/);
    assert.match(body, /Passed: 1/);
    assert.match(body, /vxc-ui-automation\/pull\/2/);
  });

  test("create-project-workflow updates a published MF workflow", async () => {
    const profiles = parseProfiles();
    const graph = buildProjectWorkflow(profiles.MF, profiles.QUT);
    const created = await Workflow.create({
      name: "old MF",
      status: "published",
      profileKey: "MF",
      runtime: "docker",
      nodes: [{ id: "start", type: "delay", config: { seconds: 0 } }],
      edges: [],
      trigger: { type: "webhook", enabled: true, config: {} },
    });
    await Workflow.updateOne(
      { _id: created._id },
      {
        $set: {
          name: graph.name,
          runtime: graph.runtime,
          retention: graph.retention,
          repository: graph.repository,
          nodes: graph.nodes,
          edges: graph.edges,
        },
      }
    );
    const saved = await Workflow.findById(created._id).lean();
    assert.equal(saved.runtime, "host");
    assert.equal(saved.retention.keepWorktreeOnFailure, true);
    assert.equal(saved.nodes.some((node) => node.type === "githubPr"), true);
    assert.equal(saved.profileKey, "MF");
  });
});
