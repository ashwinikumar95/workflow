const { v4: uuidv4 } = require("uuid");
const config = require("../../config");
const jira = require("../services/jiraService");
const analysis = require("../services/analysisService");
const prompts = require("../services/cursorPromptService");
const git = require("../services/gitService");
const { assertPullRequestGate } = require("../services/pullRequestGate");
const githubPrService = require("../services/githubPrService");

function asObject(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) return { ...input };
  return { payload: input };
}

function tokenFromWorkflow(workflow) {
  const ref = workflow && workflow.repository && workflow.repository.credentialRef;
  if (typeof ref === "string" && ref && Object.prototype.hasOwnProperty.call(process.env, ref)) {
    return process.env[ref];
  }
  return config.githubToken;
}

async function removeQuiet(runState) {
  const external = runState && runState.external ? runState.external : {};
  if (!external.worktreePath || !external.repoPath) return;
  try {
    if (runState.checkpointExternal) await runState.checkpointExternal({ worktreeState: "removing" });
    await git.removeWorktree({
      repoPath: external.repoPath,
      worktreePath: external.worktreePath,
      worktreesDir: config.worktreesDir,
    });
  } catch (err) {
    console.error("[worktree] remove failed:", err.message);
  }
}

async function jiraNode(_node, input) {
  const base = asObject(input);
  if (base.jira && base.jira.id && base.jira.key) return { ...base, jira: base.jira };
  const issue = await jira.fetchIssue(typeof base.issueKey === "string" ? base.issueKey : "");
  return { ...base, jira: issue };
}

async function analysisNode(_node, input) {
  const base = asObject(input);
  const issue = base.jira || {};
  const result = await analysis.analyzeIssue({
    summary: issue.summary,
    descriptionText: issue.descriptionText,
  });
  return { ...base, analysis: result };
}

async function cursorPromptNode(_node, input) {
  const base = asObject(input);
  const prompt = prompts.buildPrompt(base.jira || {}, base.analysis || {});
  return { ...base, prompt };
}

async function gitBranchNode(_node, input, runState) {
  const base = asObject(input);
  const created = await git.createWorktree({
    repoPath: git.resolveRepoPath(runState.workflow),
    runId: runState.runId,
    nodeId: runState.nodeId,
    issueKey: base.jira && base.jira.key,
    baseBranch: git.resolveBaseBranch(runState.workflow),
    worktreesDir: config.worktreesDir,
  });
  const external = {
    worktreePath: created.path,
    branch: created.branch,
    repoPath: created.repoPath,
    worktreeState: "ready",
  };
  if (runState.checkpointExternal) await runState.checkpointExternal(external);
  return { ...base, worktreePath: created.path, branch: created.branch };
}

async function cursorAgentNode(_node, input, runState) {
  const base = asObject(input);
  if (runState.resumed) {
    const branch = runState.completion && runState.completion.branch === "true" ? "true" : "false";
    if (branch === "false") await removeQuiet(runState);
    const result = runState.completion && runState.completion.result;
    return { ...base, branch, headSha: result && result.sha ? result.sha : null };
  }
  const worktreePath = (runState.external && runState.external.worktreePath) || base.worktreePath;
  const head = await git.revParse(worktreePath);
  const clean = await git.isClean(worktreePath);
  if (!clean) {
    await removeQuiet(runState);
    return { ...base, branch: "false" };
  }
  const agentExecutionId = uuidv4();
  const external = {
    agentExecutionId,
    preAgentSha: head,
    worktreePath,
    worktreeState: "ready",
  };
  if (runState.checkpointExternal) await runState.checkpointExternal(external);
  const externalJobId = `agent-${runState.runId}-${runState.nodeId}`;
  return {
    control: "wait",
    kind: "agent",
    output: base,
    external,
    job: {
      runId: runState.runId,
      workflowId: runState.workflowId,
      nodeId: runState.nodeId,
      prompt: typeof base.prompt === "string" ? base.prompt : "",
      worktreePath,
      externalJobId,
      agentExecutionId,
      preAgentSha: head,
    },
  };
}

async function playwrightNode(node, input, runState) {
  const base = asObject(input);
  const cfg = node.config && typeof node.config === "object" ? node.config : {};
  if (runState.resumed) {
    const branch = runState.completion && runState.completion.branch === "true" ? "true" : "false";
    if (branch === "false") await removeQuiet(runState);
    return { ...base, branch };
  }
  if (cfg.strategy !== "in-repo" && cfg.strategy !== "external-repo") {
    throw new Error("Playwright strategy is required");
  }
  if (cfg.target !== "local-worktree" && cfg.target !== "deployed-preview") {
    throw new Error("Playwright target is required");
  }
  const worktreePath = (runState.external && runState.external.worktreePath) || base.worktreePath;
  const preAgentSha = runState.external && runState.external.preAgentSha;
  const ready = await git.readyForPlaywright(worktreePath, preAgentSha);
  if (!ready.ok) {
    await removeQuiet(runState);
    return { ...base, branch: "false" };
  }
  const external = { testedSha: ready.head, worktreePath, worktreeState: "ready" };
  if (runState.checkpointExternal) await runState.checkpointExternal(external);
  const testRepository = cfg.testRepository && typeof cfg.testRepository === "object" ? cfg.testRepository : {};
  return {
    control: "wait",
    kind: "playwright",
    output: { ...base, testedSha: ready.head },
    external,
    job: {
      runId: runState.runId,
      workflowId: runState.workflowId,
      nodeId: runState.nodeId,
      externalJobId: `playwright-${runState.runId}-${runState.nodeId}`,
      strategy: cfg.strategy,
      target: cfg.target,
      testedSha: ready.head,
      appWorktree: worktreePath,
      worktreePath,
      testWorktree: cfg.strategy === "in-repo" ? worktreePath : testRepository.location,
      testPath: typeof cfg.testPath === "string" ? cfg.testPath : "",
      appCommand: Array.isArray(cfg.appCommand) ? cfg.appCommand : [],
      readiness: cfg.readiness || "/",
      testCommand: Array.isArray(cfg.testCommand) ? cfg.testCommand : [],
      preAgentSha,
    },
  };
}

async function githubPrNode(_node, input, runState) {
  const base = asObject(input);
  const external = runState.external || {};
  const head = await git.revParse(external.worktreePath);
  assertPullRequestGate({ external, predecessorId: runState.predecessorId, head });
  const token = tokenFromWorkflow(runState.workflow);
  await git.pushBranch({
    worktreePath: external.worktreePath,
    branch: external.branch,
    testedSha: external.testedSha,
    token,
  });
  const url = await githubPrService.openPullRequest({
    owner: config.githubOwner,
    repo: config.githubRepo,
    title: (base.jira && base.jira.summary) || external.branch,
    head: external.branch,
    base: git.resolveBaseBranch(runState.workflow),
    body: "",
    token,
  });
  if (runState.checkpointExternal) await runState.checkpointExternal({ prUrl: url, worktreeState: "removing" });
  try {
    await git.removeWorktree({
      repoPath: external.repoPath,
      worktreePath: external.worktreePath,
      worktreesDir: config.worktreesDir,
    });
  } catch (err) {
    console.error("[githubPr] worktree remove failed:", err.message);
  }
  return { ...base, prUrl: url };
}

module.exports = {
  jira: jiraNode,
  analysis: analysisNode,
  cursorPrompt: cursorPromptNode,
  gitBranch: gitBranchNode,
  cursorAgent: cursorAgentNode,
  playwright: playwrightNode,
  githubPr: githubPrNode,
};
