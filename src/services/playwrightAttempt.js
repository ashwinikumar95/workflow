const { redactOutput } = require("./forbiddenEnv");
const {
  detectPackageManager,
  classifyPlaywrightOutcome,
  resolvePlaywrightLayout,
  planTarget,
} = require("./playwrightPlan");
const { buildPlaywrightContainerSpec, buildPlaywrightEnv } = require("./containerSpec");
const git = require("./gitService");

function settlePayload(data, outcome, output) {
  return {
    runId: data.runId,
    workflowId: data.workflowId,
    nodeId: data.nodeId,
    kind: "playwright",
    externalJobId: data.externalJobId,
    worktreePath: data.appWorktree || data.worktreePath,
    testedSha: data.testedSha,
    result: {
      branch: outcome.branch,
      status: outcome.status,
      failureClass: outcome.failureClass,
      reportPresent: outcome.reportPresent === true,
      testedSha: data.testedSha,
      reason: outcome.reason || null,
      stdout: output ? redactOutput(output.stdout) : "",
      stderr: output ? redactOutput(output.stderr) : "",
    },
  };
}

/**
 * Plans the suite and enqueues settle-wait. Does not call GitHub and does not
 * spawn Playwright on the host. `deployed-preview` fails closed.
 */
async function handlePlaywrightJob(job, deps) {
  const data = job && job.data ? job.data : {};
  const enqueueSettle = deps.enqueueSettle;
  if (!enqueueSettle) throw new Error("enqueueSettle is required");

  const targetPlan = planTarget(data.target);
  if (targetPlan.status === "bootstrap-failed") {
    await enqueueSettle(settlePayload(data, targetPlan));
    return { booted: false };
  }

  const layout = resolvePlaywrightLayout({
    strategy: data.strategy,
    appWorktree: data.appWorktree,
    testWorktree: data.testWorktree || data.appWorktree,
  });

  const revParse = deps.revParse || git.revParse;
  const head = await revParse(layout.appCwd);
  if (head !== data.testedSha) {
    await enqueueSettle(
      settlePayload(data, {
        status: "failed",
        failureClass: "tests",
        branch: "false",
        reportPresent: false,
        reason: "sha-mismatch",
      })
    );
    return { booted: false, testCwd: layout.testCwd, appCwd: layout.appCwd };
  }

  const detected = detectPackageManager(layout.testCwd);
  if (detected.status === "bootstrap-failed") {
    await enqueueSettle(settlePayload(data, { ...detected, reportPresent: false }));
    return { booted: false, testCwd: layout.testCwd, appCwd: layout.appCwd };
  }

  if (deps.install) {
    const install = await deps.install({ cwd: layout.testCwd, command: detected.command });
    if (install && install.code !== 0) {
      const outcome = classifyPlaywrightOutcome({ installCode: install.code });
      await enqueueSettle(settlePayload(data, outcome, install));
      return { booted: false, testCwd: layout.testCwd, appCwd: layout.appCwd };
    }
  }

  if (deps.browsers) {
    const browsers = await deps.browsers({ cwd: layout.testCwd });
    if (browsers && browsers.code !== 0) {
      const outcome = classifyPlaywrightOutcome({ installCode: 0, browserCode: browsers.code });
      await enqueueSettle(settlePayload(data, outcome, browsers));
      return { booted: false, testCwd: layout.testCwd, appCwd: layout.appCwd };
    }
  }

  const env = buildPlaywrightEnv({
    baseUrl: data.baseUrl,
    gitCommit: data.testedSha,
    extraAllow: data.envAllow,
    browsersPath: data.browsersPath,
  });

  let spec = null;
  if (data.image) {
    spec = buildPlaywrightContainerSpec({
      image: data.image,
      testCwd: layout.testCwd,
      appWorktree: layout.appCwd,
      strategy: data.strategy,
      env,
    });
  }

  if (deps.timedOut) {
    const outcome = classifyPlaywrightOutcome({ installCode: 0, browserCode: 0, timedOut: true });
    await enqueueSettle(settlePayload(data, outcome));
    return { booted: Boolean(data.target === "local-worktree"), testCwd: layout.testCwd, appCwd: layout.appCwd };
  }

  if (!deps.runSuite) {
    const outcome = classifyPlaywrightOutcome({
      installCode: 0,
      browserCode: 0,
      testCode: 1,
      reportPresent: false,
    });
    await enqueueSettle(settlePayload(data, outcome));
    return { booted: false, testCwd: layout.testCwd, appCwd: layout.appCwd, spec };
  }

  const suite = await deps.runSuite({
    spec,
    testCwd: layout.testCwd,
    appCwd: layout.appCwd,
    env,
    testedSha: data.testedSha,
    command: data.testCommand,
    data,
  });
  const outcome = classifyPlaywrightOutcome({
    installCode: 0,
    browserCode: 0,
    timedOut: Boolean(suite && suite.timedOut),
    testCode: suite ? suite.code : 1,
    reportPresent: Boolean(suite && suite.reportPresent),
    failureClass: suite && suite.failureClass,
    reason: suite && suite.reason,
  });
  await enqueueSettle(settlePayload(data, outcome, suite));
  return {
    booted: data.target === "local-worktree",
    testCwd: layout.testCwd,
    appCwd: layout.appCwd,
    spec,
  };
}

module.exports = { handlePlaywrightJob };
