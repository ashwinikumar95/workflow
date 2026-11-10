const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { describe, test, before, after } = require("node:test");
const lifecycle = require("../src/nodes/lifecycle");

// Regression: a read-only review agent that ran after the implementation commit
// used to overwrite the change-set baseline with the post-implementation HEAD, so
// review, rules, test selection and Playwright all saw an empty diff.

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

describe("change-set baseline survives later agent commits", () => {
  let root;
  let repo;
  let baseSha;
  let implSha;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-sha-"));
    repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "Test"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "base"], repo);
    baseSha = git(["rev-parse", "HEAD"], repo);
    fs.writeFileSync(path.join(repo, "b.txt"), "impl\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "implementation"], repo);
    implSha = git(["rev-parse", "HEAD"], repo);
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function nodeFor(mode) {
    return { id: `agent-${mode}`, type: "cursorAgent", config: { mode, role: "app" } };
  }

  async function prepare(mode, external) {
    const saved = [];
    const result = await lifecycle.cursorAgent(
      nodeFor(mode),
      { artifactDir: path.join(root, "artifacts", mode) },
      {
        runId: "6af2d69d2218f1c6f9284f09",
        nodeId: `agent-${mode}`,
        workflowId: "6aed98273596193d40263299",
        workflow: {},
        external,
        checkpointExternal: async (patch) => saved.push(patch),
      }
    );
    return { result, patch: saved[saved.length - 1] };
  }

  test("a review agent after implementation keeps the original baseline", async () => {
    const external = {
      repos: { app: { worktreePath: repo, baselineSha: baseSha, preAgentSha: baseSha } },
    };
    const { result, patch } = await prepare("review", external);

    assert.equal(result.control, "wait");
    assert.equal(patch.repos.app.preAgentSha, implSha, "per-run pre-agent sha tracks HEAD");
    assert.equal(patch.repos.app.baselineSha, baseSha, "baseline must not move to the implementation commit");
  });

  test("a fix agent after implementation keeps the original baseline", async () => {
    const external = {
      repos: { app: { worktreePath: repo, baselineSha: baseSha, preAgentSha: baseSha } },
    };
    const { patch } = await prepare("fix", external);

    assert.equal(patch.repos.app.baselineSha, baseSha);
    assert.equal(patch.repos.app.preAgentSha, implSha);
  });

  test("the first agent on a worktree records its current HEAD as the baseline", async () => {
    const external = { repos: { app: { worktreePath: repo } } };
    const { patch } = await prepare("plan", external);

    assert.equal(patch.repos.app.baselineSha, implSha);
    assert.equal(patch.repos.app.preAgentSha, implSha);
  });

  test("baselineShaFor prefers the baseline and falls back to older fields", () => {
    const { baselineShaFor } = lifecycle;
    assert.equal(baselineShaFor({ baselineSha: "b", preAgentSha: "p" }, { preAgentSha: "x" }), "b");
    assert.equal(baselineShaFor({ preAgentSha: "p" }, { preAgentSha: "x" }), "p");
    assert.equal(baselineShaFor({}, { preAgentSha: "x" }), "x");
    assert.equal(baselineShaFor({}, {}), "");
  });
});
