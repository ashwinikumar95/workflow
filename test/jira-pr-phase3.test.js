const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const git = require("../src/services/gitService");
const { handleAgentJob } = require("../src/services/agentAttempt");
const { handlePlaywrightJob } = require("../src/services/playwrightAttempt");
const { FORBIDDEN_ENV } = require("../src/services/forbiddenEnv");
const hostProcess = require("../src/services/hostProcess");
const {
  VITE_PORTS,
  copyCredentialFiles,
  resolveVitePort,
  startAgentHost,
  runSuiteHost,
  resetPortLocks,
} = require("../src/services/hostRunners");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

describe("jira-pr phase 3 host runtime", () => {
  let root;
  let previousWorktrees;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase3-host-"));
    previousWorktrees = process.env.WORKTREES_DIR;
    process.env.WORKTREES_DIR = path.join(root, "worktrees");
    fs.mkdirSync(process.env.WORKTREES_DIR);
  });

  after(() => {
    hostProcess.setPidRegistry(null);
    resetPortLocks();
    if (previousWorktrees === undefined) delete process.env.WORKTREES_DIR;
    else process.env.WORKTREES_DIR = previousWorktrees;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(() => {
    resetPortLocks();
    hostProcess.setPidRegistry(null);
  });

  test("the child environment never contains forbidden names", () => {
    assert.ok(FORBIDDEN_ENV.includes("JIRA_EMAIL"));
    assert.ok(FORBIDDEN_ENV.includes("JIRA_WEBHOOK_SECRET"));
    const env = hostProcess.buildEnv({ CI: "1", CURSOR_API_KEY: "cursor-key" });
    for (const name of FORBIDDEN_ENV) {
      assert.equal(Object.hasOwn(env, name), false);
    }
    assert.equal(env.CURSOR_API_KEY, "cursor-key");
    assert.ok(env.PATH);
    assert.throws(() => hostProcess.buildEnv({ JIRA_API_TOKEN: "secret-token" }));
    assert.throws(() => hostProcess.buildEnv({ JIRA_EMAIL: "user@example.test" }));
  });

  test("a timed-out fake process tree is fully killed", async () => {
    const script = path.join(root, "tree.js");
    const pidsFile = path.join(root, "tree.pids");
    await fs.promises.writeFile(
      script,
      [
        'const { spawn } = require("child_process");',
        'const fs = require("fs");',
        "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 100000)\"], { stdio: \"ignore\", windowsHide: true });",
        "fs.writeFileSync(process.env.PIDS_FILE, String(process.pid) + \"\\n\" + String(child.pid));",
        "setInterval(() => {}, 100000);",
        "",
      ].join("\n")
    );
    const handle = await hostProcess.start({
      command: "node",
      args: [script],
      extraEnv: { PIDS_FILE: pidsFile },
      timeoutMs: 1500,
      role: "test-tree",
    });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(pidsFile) && Date.now() < deadline) await sleep(50);
    assert.equal(fs.existsSync(pidsFile), true);
    const pids = fs
      .readFileSync(pidsFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => Number(line))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    assert.ok(pids.length >= 2);
    const result = await handle.wait;
    assert.equal(result.timedOut, true);
    const deadBy = Date.now() + 5000;
    for (const pid of pids) {
      while ((await isAlive(pid)) && Date.now() < deadBy) await sleep(50);
      assert.equal(await isAlive(pid), false, `pid ${pid} still alive`);
    }
  });

  test("a second run for the same app waits for that app's port", async () => {
    assert.equal(VITE_PORTS.fuji, 5182);
    assert.equal(VITE_PORTS.central, 5181);
    assert.equal(resolveVitePort(["npx", "vite", "--port", "5182", "--strictPort"], "fuji"), 5182);
    assert.equal(resolveVitePort(["npx", "vite", "--port", "5181", "--strictPort"], "central"), 5181);
    assert.equal(resolveVitePort(["npx", "vite"], "Fuji-Vue3"), 5182);
    assert.equal(resolveVitePort(["npx", "vite"], "Mt-Fuji-Central"), 5181);
    assert.throws(() => resolveVitePort(["npx", "vite", "--port", "5181"], "fuji"));
    assert.throws(() => resolveVitePort(["npx", "vite", "--port", "5182"], "central"));

    const events = [];
    const firstUnlock = await hostProcess.reservePort(VITE_PORTS.fuji);
    events.push("fuji-1");
    let secondHeld = false;
    const second = hostProcess.reservePort(VITE_PORTS.fuji).then((unlock) => {
      secondHeld = true;
      events.push("fuji-2");
      unlock();
    });
    const central = hostProcess.reservePort(VITE_PORTS.central).then((unlock) => {
      events.push("central");
      unlock();
    });
    await central;
    await sleep(50);
    assert.equal(secondHeld, false);
    assert.ok(events.includes("fuji-1"));
    assert.ok(events.includes("central"));
    firstUnlock();
    await second;
    assert.equal(secondHeld, true);
    assert.deepEqual(
      events.filter((name) => name.startsWith("fuji")),
      ["fuji-1", "fuji-2"]
    );
  });

  test("a missing .auth stops with env", async () => {
    const source = path.join(root, "auth-src");
    const dest = path.join(root, "auth-dest");
    await initRepo(dest, "tests\n");
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.writeFile(path.join(source, ".env"), "BASE_URL=http://localhost:5182\n");
    const copied = await copyCredentialFiles({
      sourceRepoPath: source,
      destWorktree: dest,
      credentialFiles: [".env", "playwright/.auth"],
    });
    assert.equal(copied.failureClass, "env");
    assert.equal(copied.reason, "env");

    await fs.promises.writeFile(path.join(dest, "package-lock.json"), "{}");
    const sha = await git.revParse(dest);
    const settled = [];
    await handlePlaywrightJob(
      {
        data: {
          runId: "c".repeat(24),
          nodeId: "pw",
          externalJobId: `playwright-${"c".repeat(24)}-pw`,
          strategy: "in-repo",
          target: "local-worktree",
          testedSha: sha,
          appWorktree: dest,
          testWorktree: dest,
          runtime: "host",
          credentialFiles: [".env", "playwright/.auth"],
          sourceRepoPath: source,
          testCommand: [process.execPath, "-e", "process.exit(0)"],
        },
      },
      {
        enqueueSettle: async (payload) => settled.push(payload),
        runSuite: (opts) => runSuiteHost(opts),
      }
    );
    assert.equal(settled.length, 1);
    assert.equal(settled[0].result.failureClass, "env");
    assert.equal(settled[0].result.branch, "false");
  });

  test("the agent settle path works with a fake agent script that commits in a temp repo", async () => {
    const repo = path.join(root, "agent-repo");
    const worktrees = process.env.WORKTREES_DIR;
    await initRepo(repo, "app\n");
    const runId = "a".repeat(24);
    const created = await git.createWorktree({
      repoPath: repo,
      runId,
      nodeId: "agent1",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    const preAgentSha = await git.revParse(created.path);
    const entry = path.join(root, "fake-agent.cjs");
    await fs.promises.writeFile(
      entry,
      [
        'const { execSync } = require("child_process");',
        'const fs = require("fs");',
        'const path = require("path");',
        "const cwd = process.env.WORKFLOW_CWD;",
        'fs.writeFileSync(path.join(cwd, "ok.txt"), "done\\n");',
        'execSync("git add ok.txt", { cwd, windowsHide: true });',
        'execSync("git -c user.email=test@example.com -c user.name=Test commit -m fake", { cwd, windowsHide: true });',
        "const receipt = process.env.WORKFLOW_RECEIPT_PATH;",
        "if (receipt) {",
        "  fs.mkdirSync(path.dirname(receipt), { recursive: true });",
        '  fs.writeFileSync(receipt, JSON.stringify({ ok: true }));',
        "}",
        "",
      ].join("\n")
    );
    const settled = [];
    await handleAgentJob(
      {
        data: {
          runId,
          workflowId: "w".repeat(24),
          nodeId: "agent1",
          externalJobId: `agent-${runId}-agent1`,
          worktreePath: created.path,
          preAgentSha,
          agentExecutionId: "exec-1",
          prompt: "commit a file",
          runtime: "host",
          entry,
        },
      },
      {
        enqueueSettle: async (payload) => settled.push(payload),
        startContainer: startAgentHost,
      }
    );
    assert.equal(settled.length, 1);
    assert.equal(settled[0].result.branch, "true");
    assert.equal(settled[0].result.status, "finished");
    assert.equal(await git.isClean(created.path), true);
    assert.notEqual(await git.revParse(created.path), preAgentSha);
  });
});
