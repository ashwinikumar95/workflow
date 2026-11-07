const { redactOutput } = require("./forbiddenEnv");
const {
  detectPackageManager,
  classifyPlaywrightOutcome,
  resolvePlaywrightLayout,
  planTarget,
} = require("./playwrightPlan");
const { buildPlaywrightContainerSpec, buildPlaywrightEnv } = require("./containerSpec");
const git = require("./gitService");
const playwrightReport = require("./playwrightReport");
const artifactRedactor = require("./artifactRedactor");
const baseline = require("./baseline");
const { classifyFailure } = require("./failureClassification");

function settlePayload(data, outcome, output, extra) {
  const more = extra && typeof extra === "object" ? extra : {};
  return {
    runId: data.runId,
    workflowId: data.workflowId,
    nodeId: data.nodeId,
    kind: "playwright",
    externalJobId: data.externalJobId,
    worktreePath: data.testedWorktree || data.appWorktree || data.worktreePath,
    testedSha: data.testedSha,
    testedShas: data.testedShas,
    result: {
      branch: outcome.branch,
      status: outcome.status,
      failureClass: outcome.failureClass,
      reportPresent: outcome.reportPresent === true,
      testedSha: data.testedSha,
      testedShas: data.testedShas || null,
      reason: outcome.reason || null,
      stdout: output ? redactOutput(output.stdout) : "",
      stderr: output ? redactOutput(output.stderr) : "",
      preexistingOnly: outcome.preexistingOnly === true,
      report: more.report || null,
      baseline: more.baseline || null,
      classification: more.classification || null,
      artifacts: more.artifacts || null,
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
  const checkedPath = data.testedWorktree || layout.appCwd;
  const head = await revParse(checkedPath);
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

  const command = Array.isArray(data.testCommand) ? data.testCommand.slice() : [];
  const selection = data.selection && typeof data.selection === "object" ? data.selection : null;
  if (selection && Array.isArray(selection.selectedPaths)) {
    for (const arg of selection.selectedPaths) {
      if (arg != null && arg !== "" && !command.includes(String(arg))) command.push(String(arg));
    }
  }
  const suite = await deps.runSuite({
    spec,
    testCwd: layout.testCwd,
    appCwd: layout.appCwd,
    env,
    testedSha: data.testedSha,
    command,
    data,
  });
  let outcome = classifyPlaywrightOutcome({
    installCode: 0,
    browserCode: 0,
    timedOut: Boolean(suite && suite.timedOut),
    testCode: suite ? suite.code : 1,
    reportPresent: Boolean(suite && suite.reportPresent),
    failureClass: suite && suite.failureClass,
    reason: suite && suite.reason,
  });
  const report = playwrightReport.parseReportFromWorktree(layout.testCwd);
  let artifacts = null;
  try {
    artifacts = await artifactRedactor.collectAttempt({
      runId: data.runId,
      attempt: Number(data.attempt) || 1,
      testCwd: layout.testCwd,
      appCwd: layout.appCwd,
    });
  } catch (err) {
    console.error("[playwright] artifact collect failed:", err && err.message);
  }

  let baselineResult = null;
  if (outcome.failureClass === "tests" && data.baseline !== true && typeof deps.runBaseline === "function") {
    try {
      const failedArgs = baseline.failedTestArgs(report);
      const changedConfig = baseline.collectRunConfig({
        testCwd: layout.testCwd,
        env,
        args: failedArgs,
        report,
      });
      baselineResult = await deps.runBaseline({
        data,
        layout,
        env,
        report,
        appCwd: layout.appCwd,
        testCwd: layout.testCwd,
        changedConfig,
        command: failedArgs,
      });
    } catch (err) {
      baselineResult = {
        inconclusive: true,
        status: "inconclusive",
        reason: err && err.message ? err.message : "baseline-failed",
      };
    }
  }

  const comparison = baselineResult && baselineResult.comparison ? baselineResult.comparison : null;
  if (
    outcome.failureClass === "tests" &&
    comparison &&
    comparison.blocks === false &&
    comparison.ownScenarioPassed
  ) {
    outcome = { ...outcome, branch: "true", status: "passed", preexistingOnly: true };
  }

  const classified =
    outcome.branch === "true" && outcome.preexistingOnly !== true
      ? null
      : classifyFailure({
          outcome,
          agentResult: data.agentResult,
          baseline: comparison,
          kind: data.ticketKind,
          inOwnScenario: comparison ? comparison.ownScenarioPassed === false : true,
        });

  await enqueueSettle(
    settlePayload(data, outcome, suite, {
      report,
      baseline: baselineResult,
      classification: classified,
      artifacts,
    })
  );
  return {
    booted: data.target === "local-worktree",
    testCwd: layout.testCwd,
    appCwd: layout.appCwd,
    spec,
  };
}

module.exports = { handlePlaywrightJob };
