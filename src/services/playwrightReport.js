const fs = require("fs");
const path = require("path");

function posix(file) {
  return String(file || "").replace(/\\/g, "/");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function errorText(result) {
  if (!result || typeof result !== "object") return "";
  if (result.error && typeof result.error.message === "string") return result.error.message;
  const errors = asArray(result.errors);
  for (const err of errors) {
    if (err && typeof err.message === "string" && err.message) return err.message;
  }
  return "";
}

function failedStep(result) {
  const steps = asArray(result && result.steps);
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step && (step.error || step.status === "failed" || step.status === "timedOut")) {
      return typeof step.title === "string" ? step.title : "";
    }
  }
  return "";
}

function tracePathOf(result) {
  for (const attachment of asArray(result && result.attachments)) {
    if (!attachment) continue;
    const name = String(attachment.name || "").toLowerCase();
    const file = typeof attachment.path === "string" ? attachment.path : "";
    if (name === "trace" || file.toLowerCase().endsWith(".zip")) return posix(file);
  }
  return "";
}

function lastResult(test) {
  const results = asArray(test && test.results);
  return results.length ? results[results.length - 1] : null;
}

function classifyTest(test) {
  const status = test && test.status;
  if (status === "flaky") return "flaky";
  if (status === "skip" || status === "skipped") return "skipped";
  if (status === "unexpected") return "failed";
  if (status === "expected") return "passed";
  const results = asArray(test && test.results);
  if (!results.length) return "skipped";
  const last = results[results.length - 1];
  const lastStatus = last && last.status;
  const hadFail = results.some((row) => row && (row.status === "failed" || row.status === "timedOut"));
  if (lastStatus === "skipped") return "skipped";
  if (lastStatus === "interrupted") return "failed";
  if (lastStatus === "passed" && hadFail) return "flaky";
  if (lastStatus === "failed" || lastStatus === "timedOut") return "failed";
  if (lastStatus === "passed") return "passed";
  return "failed";
}

function walkSuite(suite, ancestors, out) {
  if (!suite || typeof suite !== "object") return;
  const title = typeof suite.title === "string" && suite.title ? suite.title : "";
  const chain = title ? ancestors.concat(title) : ancestors.slice();
  for (const spec of asArray(suite.specs)) {
    const specTitle = typeof spec.title === "string" ? spec.title : "";
    const fullTitle = chain.concat(specTitle).filter(Boolean).join(" › ");
    const file = posix(spec.file || suite.file || "");
    for (const test of asArray(spec.tests)) {
      const kind = classifyTest(test);
      const result = lastResult(test);
      const row = {
        title: fullTitle,
        file,
        project: test && test.projectName ? String(test.projectName) : "",
        status: kind,
        error: kind === "failed" || kind === "flaky" ? errorText(result) : "",
        step: kind === "failed" ? failedStep(result) : "",
        tracePath: result ? tracePathOf(result) : "",
      };
      if (kind === "passed") out.passed.push(row);
      else if (kind === "flaky") out.flaky.push(row);
      else if (kind === "failed") out.failures.push(row);
    }
  }
  for (const child of asArray(suite.suites)) walkSuite(child, chain, out);
}

function emptySummary() {
  return {
    passed: [],
    failed: [],
    flaky: [],
    failures: [],
    counts: { passed: 0, failed: 0, flaky: 0 },
  };
}

function parseReport(raw) {
  const report = typeof raw === "string" ? JSON.parse(raw) : raw;
  const out = emptySummary();
  if (!report || typeof report !== "object") return out;
  for (const suite of asArray(report.suites)) walkSuite(suite, [], out);
  out.failed = out.failures.slice();
  out.counts = {
    passed: out.passed.length,
    failed: out.failures.length,
    flaky: out.flaky.length,
  };
  out.config = {
    version: report.config && report.config.version ? String(report.config.version) : "",
    workers: report.config && report.config.workers != null ? report.config.workers : null,
    projects: asArray(report.config && report.config.projects).map((project) =>
      project && project.name ? String(project.name) : ""
    ),
  };
  return out;
}

function parseReportFile(file) {
  if (!file || !fs.existsSync(file)) return emptySummary();
  return parseReport(fs.readFileSync(file, "utf8"));
}

function parseReportFromWorktree(testCwd) {
  return parseReportFile(path.join(testCwd || "", "test-results", "report.json"));
}

module.exports = {
  parseReport,
  parseReportFile,
  parseReportFromWorktree,
  emptySummary,
};
