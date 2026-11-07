const config = require("../../config");
const { redactText } = require("./artifactRedactor");

function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== "");
  if (value == null || value === "") return [];
  return [value];
}

function ruleName(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const file = item.file || item.rule || item.ruleFile;
  return file ? String(file) : "";
}

function browseUrl(issueKey) {
  const base = String(config.jiraBaseUrl || "").replace(/\/$/, "");
  const key = typeof issueKey === "string" ? issueKey.trim() : "";
  if (!base || !key) return "";
  return `${base}/browse/${key}`;
}

function linkedPrFrom(input) {
  if (input && typeof input.linkedPrUrl === "string" && input.linkedPrUrl) return input.linkedPrUrl;
  const repos = input && input.external && input.external.repos;
  if (repos && repos.automation && typeof repos.automation.prUrl === "string") return repos.automation.prUrl;
  return "";
}

function countsFrom(input) {
  const report = input && input.playwrightReport;
  const counts = report && report.counts ? report.counts : null;
  if (counts) {
    return {
      passed: Number(counts.passed) || 0,
      failed: Number(counts.failed) || 0,
      flaky: Number(counts.flaky) || 0,
    };
  }
  return { passed: 0, failed: 0, flaky: 0 };
}

function gateLines(input) {
  const checks = input && input.rulesChecks;
  if (!checks) return ["Gates: not recorded"];
  if (checks.ok === true) return ["Mechanical rules checks: passed"];
  const violations = asList(checks.violations).map((item) => {
    if (typeof item === "string") return `- ${item}`;
    if (item && typeof item === "object") {
      const file = item.file || item.rule || "gate";
      const detail = item.detail || item.message || item.id || "";
      return `- ${file}${detail ? `: ${detail}` : ""}`;
    }
    return "- violation";
  });
  return ["Mechanical rules checks: failed", ...violations];
}

function buildPrTitle(input, fallback) {
  const key = (input && input.jira && input.jira.key) || input.issueKey || "";
  const summary = (input && input.jira && input.jira.summary) || "";
  if (key && summary) return `${key}: ${summary}`;
  if (summary) return summary;
  if (key) return key;
  return fallback || "workflow change";
}

function buildPrBody(input, options = {}) {
  const issue = (input && input.jira) || {};
  const key = issue.key || input.issueKey || "";
  const jiraLink = browseUrl(key);
  const plan = (input && input.plan) || {};
  const rules = asList(input && (input.rulesApplied || plan.rulesApplied)).map(ruleName).filter(Boolean);
  const deviations = asList(input && input.deviations);
  const selection = (input && input.selection) || {};
  const modules = asList(selection.selectedModules);
  const tests = asList(selection.selectedPaths);
  const counts = countsFrom(input);
  const linked = options.linkedPrUrl || linkedPrFrom(input);
  const lines = [];

  lines.push("## Jira");
  lines.push(jiraLink || key || "(none)");
  lines.push("");
  lines.push("## Plan");
  lines.push(typeof plan.approach === "string" && plan.approach ? plan.approach : "(no plan summary)");
  const files = asList(plan.filesToChange);
  if (files.length) {
    lines.push("");
    lines.push("Files:");
    for (const file of files) lines.push(`- ${file}`);
  }
  lines.push("");
  lines.push("## Rules applied");
  if (rules.length) for (const rule of rules) lines.push(`- ${rule}`);
  else lines.push("(none listed)");
  lines.push("");
  lines.push("## Deviations");
  if (deviations.length) for (const item of deviations) lines.push(`- ${item}`);
  else lines.push("None");
  lines.push("");
  lines.push("## Gate results");
  lines.push(...gateLines(input));
  lines.push("");
  lines.push("## Tests");
  if (modules.length) lines.push(`Modules: ${modules.join(", ")}`);
  if (tests.length) lines.push(`Paths: ${tests.join(", ")}`);
  if (selection.fallback) lines.push(`Fallback: ${asList(selection.fallback).join(" ") || "yes"}`);
  lines.push(`Passed: ${counts.passed}. Failed: ${counts.failed}. Flaky: ${counts.flaky}.`);
  lines.push("");
  lines.push("## Linked PR");
  lines.push(linked || "None");
  lines.push("");

  return redactText(lines.join("\n").trim() + "\n");
}

module.exports = {
  browseUrl,
  buildPrTitle,
  buildPrBody,
};
