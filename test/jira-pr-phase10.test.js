const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const git = require("../src/services/gitService");
const github = require("../src/services/githubPrService");
const lifecycle = require("../src/nodes/lifecycle");
const { parseProfiles } = require("../src/services/projectRegistry");
const { validateWorkflowGraph } = require("../src/utils/workflowGraph");
const { assertPullRequestGate } = require("../src/services/pullRequestGate");
const {
  loadTemplate,
  buildProjectWorkflow,
  everyTerminalPathHasNotify,
  notifyThenJiraOnStops,
  reachableIds,
  successors,
} = require("../src/services/workflowTemplate");
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

function stubApp(extra = {}) {
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

function stubAuto(extra = {}) {
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

function nodesOf(graph, type, predicate) {
  return graph.nodes.filter((node) => node.type === type && (!predicate || predicate(node)));
}

function trueTarget(graph, id) {
  const next = successors(graph.edges, id, "true");
  assert.equal(next.length, 1, `${id} should have one true edge`);
  return next[0];
}

describe("jira-pr phase 10 automation tickets and linked PRs", () => {
  let root;
  let appRepo;
  let autoRepo;
  let worktrees;
  let previousWorktrees;

  before(async () => {
    await connectTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase10-"));
    appRepo = path.join(root, "app");
    autoRepo = path.join(root, "auto");
    worktrees = path.join(root, "worktrees");
    await fs.promises.mkdir(worktrees);
    await initRepo(appRepo, "app\n");
    await initRepo(autoRepo, "automation\n");
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

  test("both templates generate for all four profiles", () => {
    assert.equal(loadTemplate("automation-ticket").kind, "automation-ticket");
    const profiles = parseProfiles();
    const pairs = [
      ["MF", "QUT"],
      ["MFC", "TAC"],
      ["QUT", "MF"],
      ["TAC", "MFC"],
    ];
    for (const [key, linkedKey] of pairs) {
      const graph = buildProjectWorkflow(profiles[key], profiles[linkedKey]);
      const check = validateWorkflowGraph(graph);
      assert.equal(check.ok, true, `${key}: ${check.message}`);
      assert.equal(graph.profileKey, key);
      assert.equal(graph.runtime, "host");
      assert.equal(everyTerminalPathHasNotify(graph.nodes, graph.edges), true);
      assert.equal(notifyThenJiraOnStops(graph.nodes, graph.edges), true);
      if (profiles[key].kind === "app") {
        assert.equal(graph.kind, "app-ticket");
        assert.equal(nodesOf(graph, "gitBranch", (node) => node.config.detached).length, 1);
        assert.equal(nodesOf(graph, "githubPr", (node) => node.config.role === "app").length, 1);
        assert.equal(nodesOf(graph, "githubPr", (node) => node.config.role === "automation").length, 1);
      } else {
        assert.equal(graph.kind, "automation-ticket");
        const gitApp = graph.nodes.find((node) => node.id === "gitApp");
        const gitAuto = graph.nodes.find((node) => node.id === "gitAuto");
        assert.equal(gitApp.config.detached, true);
        assert.equal(gitApp.config.role, "app");
        assert.equal(gitAuto.config.detached, undefined);
        assert.equal(gitAuto.config.role, "automation");
        assert.equal(nodesOf(graph, "githubPr").length, 1);
        assert.equal(nodesOf(graph, "githubPr")[0].config.role, "automation");
        assert.equal(
          nodesOf(graph, "cursorAgent", (node) => node.config.mode === "implement" || node.config.mode === "fix").every(
            (node) => node.config.role === "automation"
          ),
          true
        );
      }
    }
  });

  test("an app bug never leads to a script change", () => {
    const graph = buildProjectWorkflow(stubAuto(), stubApp());
    const appBugNodes = nodesOf(
      graph,
      "condition",
      (node) =>
        node.config &&
        node.config.field === "failureClassification.value.classification" &&
        node.config.value === "app-bug"
    );
    assert.ok(appBugNodes.length > 0);
    for (const node of appBugNodes) {
      assert.equal(trueTarget(graph, node.id), "notifyAppBug");
    }
    const afterBug = reachableIds(graph.nodes, graph.edges, "notifyAppBug");
    const scriptAgents = nodesOf(
      graph,
      "cursorAgent",
      (node) => node.config && (node.config.mode === "fix" || node.config.mode === "implement")
    );
    for (const agent of scriptAgents) {
      assert.equal(afterBug.has(agent.id), false, `app-bug path reached ${agent.id}`);
    }
    const notify = graph.nodes.find((node) => node.id === "notifyAppBug");
    assert.equal(notify.config.eventType, "app_bug_blocked");
    assert.equal(graph.nodes.find((node) => node.id === "jiraAppBug").type, "jiraUpdate");
  });

  test("app-ticket script-bug routes to a second automation worktree and PR", () => {
    const graph = buildProjectWorkflow(stubApp(), stubAuto());
    const linked = nodesOf(
      graph,
      "condition",
      (node) => node.config && node.config.field === "failureClassification.routing.action"
    );
    assert.ok(linked.length > 0);
    for (const node of linked) {
      assert.equal(node.config.value, "linked_automation_run");
      assert.equal(trueTarget(graph, node.id), "lgit");
    }
    const lgit = graph.nodes.find((node) => node.id === "lgit");
    assert.equal(lgit.type, "gitBranch");
    assert.equal(lgit.config.role, "automation");
    assert.equal(lgit.config.detached, undefined);
    assert.equal(lgit.config.repository.repo, "vxc-ui-automation");
    const lprompt = graph.nodes.find((node) => node.id === "lprompt");
    assert.equal(lprompt.config.linkedScript, true);
    const autoPr = graph.nodes.find((node) => node.id === "autoPr");
    assert.equal(autoPr.type, "githubPr");
    assert.equal(autoPr.config.role, "automation");
    assert.deepEqual(successors(graph.edges, "autoPr", "true"), ["pr"]);
    const fromLinked = reachableIds(graph.nodes, graph.edges, "lgit");
    assert.equal(fromLinked.has("autoPr"), true);
    assert.equal(fromLinked.has("pr"), true);
    assert.equal(fromLinked.has("notifyAppBug"), true);
  });

  test("createCleanWorktree is detached and does not create a feature branch", async () => {
    const created = await git.createCleanWorktree({
      repoPath: appRepo,
      runId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      nodeId: "gitApp",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    assert.equal(created.detached, true);
    assert.equal(created.branch, "");
    const head = (await git.runGit(["-C", created.path, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    assert.equal(head, "HEAD");
    const branches = (await git.runGit(["-C", appRepo, "branch", "--list", "wf/*"])).stdout.trim();
    assert.equal(branches, "");
    await git.removeWorktree({
      repoPath: appRepo,
      worktreePath: created.path,
      worktreesDir: worktrees,
    });
  });

  test("the linked PR flow keeps separate SHAs and gates per repo", async () => {
    process.env.PHASE10_GITHUB_TOKEN = "phase10-token";
    const originalOpen = github.openPullRequest;
    const originalUpdate = github.updatePullRequestBody;
    const opened = [];
    const updated = [];
    github.openPullRequest = async (args) => {
      opened.push(args);
      if (args.repo === "vxc-ui-automation") return "https://github.com/Vxceed-IN/vxc-ui-automation/pull/4";
      return "https://github.com/Vxceed-IN/Fuji-Vue3/pull/5";
    };
    github.updatePullRequestBody = async (args) => {
      updated.push(args);
      return true;
    };
    git.setGitRunner(async (args) => {
      const blob = args.join(" ");
      if (args.includes("rev-parse")) {
        if (blob.includes("missing-auto")) return { stdout: "auto-sha\n", stderr: "", code: 0 };
        return { stdout: "app-sha\n", stderr: "", code: 0 };
      }
      if (args.includes("get-url")) {
        if (blob.includes("missing-auto")) {
          return { stdout: "https://github.com/Vxceed-IN/vxc-ui-automation.git\n", stderr: "", code: 0 };
        }
        return { stdout: "https://github.com/Vxceed-IN/Fuji-Vue3.git\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const appSha = "app-sha";
    const autoSha = "auto-sha";
    const pwEntry = {
      status: "passed",
      reportPresent: true,
      testedSha: autoSha,
      testedShas: { app: appSha, automation: autoSha },
    };
    const saved = [];
    const runState = {
      runId: new (require("mongoose").Types.ObjectId)().toString(),
      predecessorId: "autoPr",
      workflow: { repository: { defaultBranch: "main", credentialRef: "GITHUB_TOKEN" } },
      external: {
        repos: {
          app: {
            testedSha: appSha,
            branch: "wf/MF-10/aaaaaaaaaaaaaaaaaaaaaaaa",
            worktreePath: path.join(worktrees, "missing-app"),
            repoPath: appRepo,
            playwrightByNode: { l0_pw: pwEntry },
          },
          automation: {
            testedSha: autoSha,
            branch: "wf/MF-10/aaaaaaaaaaaaaaaaaaaaaaaa",
            worktreePath: path.join(worktrees, "missing-auto"),
            repoPath: autoRepo,
            prOwner: "Vxceed-IN",
            prRepo: "vxc-ui-automation",
            playwrightByNode: { l0_pw: pwEntry },
          },
        },
        playwrightByNode: { l0_pw: pwEntry },
      },
      checkpointExternal: async (patch) => {
        saved.push(patch);
      },
    };

    assert.doesNotThrow(() =>
      assertPullRequestGate({
        external: runState.external,
        predecessorId: "l0_pw",
        head: autoSha,
        role: "automation",
      })
    );
    assert.doesNotThrow(() =>
      assertPullRequestGate({
        external: runState.external,
        predecessorId: "autoPr",
        head: appSha,
        role: "app",
      })
    );

    const input = {
      jira: { key: "MF-10", summary: "Fix the form" },
      plan: { approach: "Change the form", filesToChange: ["src/Form.vue"] },
      playwrightReport: { counts: { passed: 2, failed: 0, flaky: 0 } },
    };

    try {
      runState.predecessorId = "l0_pw";
      const autoPr = await lifecycle.githubPr(
        {
          config: {
            role: "automation",
            retries: 1,
            repository: {
              owner: "Vxceed-IN",
              repo: "vxc-ui-automation",
              defaultBranch: "main",
              credentialRef: "PHASE10_GITHUB_TOKEN",
            },
          },
        },
        input,
        runState
      );
      runState.external.repos.automation.prUrl = autoPr.linkedPrUrl;
      runState.external.repos.automation.prOwner = "Vxceed-IN";
      runState.external.repos.automation.prRepo = "vxc-ui-automation";
      runState.predecessorId = "autoPr";
      const appPr = await lifecycle.githubPr(
        {
          config: {
            role: "app",
            retries: 1,
            repository: {
              owner: "Vxceed-IN",
              repo: "Fuji-Vue3",
              defaultBranch: "main",
              credentialRef: "PHASE10_GITHUB_TOKEN",
            },
          },
        },
        { ...input, linkedPrUrl: autoPr.linkedPrUrl },
        runState
      );
      assert.equal(autoPr.linkedPrUrl, "https://github.com/Vxceed-IN/vxc-ui-automation/pull/4");
      assert.equal(appPr.prUrl, "https://github.com/Vxceed-IN/Fuji-Vue3/pull/5");
      assert.equal(appPr.linkedPrUrl, autoPr.linkedPrUrl);
      assert.equal(opened.length, 2);
      assert.equal(opened[0].repo, "vxc-ui-automation");
      assert.equal(opened[1].repo, "Fuji-Vue3");
      assert.match(opened[1].body, /vxc-ui-automation\/pull\/4/);
      assert.equal(updated.length, 1);
      assert.equal(updated[0].repo, "vxc-ui-automation");
      assert.match(updated[0].body, /Fuji-Vue3\/pull\/5/);
      assert.equal(saved.some((patch) => patch.repos && patch.repos.app && patch.repos.app.prUrl), true);
      assert.equal(saved.some((patch) => patch.repos && patch.repos.automation && patch.repos.automation.prUrl), true);
    } finally {
      github.openPullRequest = originalOpen;
      github.updatePullRequestBody = originalUpdate;
      git.setGitRunner(null);
      delete process.env.PHASE10_GITHUB_TOKEN;
    }
  });
});
