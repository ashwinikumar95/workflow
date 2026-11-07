const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function posix(file) {
  return String(file || "").replace(/\\/g, "/");
}

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashPath(file) {
  if (!file || !fs.existsSync(file)) return "";
  const stats = fs.statSync(file);
  if (stats.isDirectory()) {
    const parts = [];
    for (const name of fs.readdirSync(file).sort()) {
      parts.push(name, hashPath(path.join(file, name)));
    }
    return hashBuffer(Buffer.from(parts.join("\0")));
  }
  return hashBuffer(fs.readFileSync(file));
}

function schemeOf(url) {
  const text = String(url || "");
  const match = text.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return match ? match[1].toLowerCase() : "";
}

function collectRunConfig({ testCwd, env, args, report, workers, browserVersion } = {}) {
  const cwd = testCwd || "";
  return {
    envHash: hashPath(path.join(cwd, ".env")),
    authHash: hashPath(path.join(cwd, "playwright", ".auth")),
    baseUrlScheme: schemeOf(env && env.BASE_URL),
    baseUrl: env && env.BASE_URL ? String(env.BASE_URL) : "",
    playwrightProject: report && report.config && Array.isArray(report.config.projects)
      ? report.config.projects.filter(Boolean).join(",")
      : "",
    args: Array.isArray(args) ? args.slice() : [],
    ci: env && env.CI != null ? String(env.CI) : "1",
    workers: workers != null ? workers : report && report.config ? report.config.workers : null,
    browserVersion:
      browserVersion ||
      (report && report.config && report.config.version) ||
      "",
  };
}

function configsEquivalent(left, right) {
  if (!left || !right) return { ok: false, reason: "missing-config" };
  const keys = [
    "envHash",
    "authHash",
    "baseUrlScheme",
    "ci",
    "workers",
    "browserVersion",
  ];
  for (const key of keys) {
    if (String(left[key] == null ? "" : left[key]) !== String(right[key] == null ? "" : right[key])) {
      return { ok: false, reason: key };
    }
  }
  const leftArgs = JSON.stringify(left.args || []);
  const rightArgs = JSON.stringify(right.args || []);
  if (leftArgs !== rightArgs) return { ok: false, reason: "args" };
  if (String(left.playwrightProject || "") !== String(right.playwrightProject || "")) {
    return { ok: false, reason: "playwrightProject" };
  }
  return { ok: true, reason: "" };
}

function normalizeError(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegex(text) {
  return String(text).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function failedTestArgs(report) {
  const failures = report && Array.isArray(report.failures) ? report.failures : [];
  const files = [];
  const titles = [];
  for (const row of failures) {
    if (row && row.file && !files.includes(posix(row.file))) files.push(posix(row.file));
    if (row && row.title) titles.push(row.title);
  }
  const args = files.slice();
  if (titles.length) args.push("-g", titles.map(escapeRegex).join("|"));
  return args;
}

function indexByKey(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    map.set(`${posix(row.file)}::${row.title}`, row);
  }
  return map;
}

function inSelection(failure, selection) {
  if (!failure || !selection) return false;
  const file = posix(failure.file);
  const modules = Array.isArray(selection.selectedModules) ? selection.selectedModules : [];
  const tags = Array.isArray(selection.tags) ? selection.tags : [];
  if (modules.some((name) => file.includes(`/${posix(name)}/`) || file.includes(`/${posix(name)}.`) || file.endsWith(`/${posix(name)}`))) {
    return true;
  }
  if (tags.length && tags.some((tag) => String(failure.title || "").includes(tag))) return true;
  const paths = Array.isArray(selection.selectedPaths) ? selection.selectedPaths : [];
  return paths.some((part) => part && !String(part).startsWith("-") && file.includes(posix(part)));
}

function inChangedFiles(failure, changedFiles) {
  const file = posix(failure && failure.file);
  if (!file) return false;
  return (changedFiles || []).some((item) => posix(item) === file || file.endsWith(`/${posix(item)}`) || posix(item).endsWith(`/${path.posix.basename(file)}`));
}

function ownScenarioRan(report, selection) {
  const rows = [
    ...((report && report.passed) || []),
    ...((report && report.failures) || []),
    ...((report && report.flaky) || []),
  ];
  if (!selection) return rows.length > 0;
  const matched = rows.filter((row) => inSelection(row, selection));
  return matched.length > 0;
}

function ownScenarioPassed(report, selection) {
  if (!ownScenarioRan(report, selection)) return false;
  const failed = ((report && report.failures) || []).some((row) => inSelection(row, selection));
  return !failed;
}

function compareBaseline({
  changed,
  baseline,
  changedConfig,
  baselineConfig,
  selection,
  changedFiles,
  baselineStatus,
} = {}) {
  const equivalent = configsEquivalent(changedConfig, baselineConfig);
  if (baselineStatus === "inconclusive" || baselineStatus === "env" || !equivalent.ok) {
    const rows = ((changed && changed.failures) || []).map((row) => ({
      title: row.title,
      file: row.file,
      changed: "fail",
      baseline: "inconclusive",
      sameError: false,
      meaning: "unknown",
      blocks: true,
      inOwnScenario: inSelection(row, selection),
    }));
    return {
      equivalent: false,
      inconclusive: true,
      reason: equivalent.ok ? baselineStatus || "inconclusive" : equivalent.reason,
      rows,
      summary: { regressions: 0, preexisting: 0, unknown: rows.length },
      blocks: true,
      ownScenarioPassed: ownScenarioPassed(changed, selection),
      ownScenarioRan: ownScenarioRan(changed, selection),
    };
  }

  const baseIndex = indexByKey((baseline && baseline.failures) || []);
  const basePassed = indexByKey((baseline && baseline.passed) || []);
  const rows = [];
  let regressions = 0;
  let preexisting = 0;
  let unknown = 0;
  let blocks = false;

  for (const row of (changed && changed.failures) || []) {
    const key = `${posix(row.file)}::${row.title}`;
    const baseFail = baseIndex.get(key);
    const basePass = basePassed.get(key);
    const own = inSelection(row, selection);
    const agentTouched = inChangedFiles(row, changedFiles);
    let meaning = "unknown";
    let sameError = false;
    let baselineOutcome = "missing";
    let rowBlocks = true;

    if (basePass && !baseFail) {
      meaning = "regression";
      baselineOutcome = "pass";
      regressions += 1;
      rowBlocks = true;
    } else if (baseFail) {
      baselineOutcome = "fail";
      sameError =
        normalizeError(row.error) === normalizeError(baseFail.error) &&
        String(row.step || "") === String(baseFail.step || "");
      if (sameError) {
        const outside = !own && !agentTouched;
        if (outside) {
          meaning = "pre-existing";
          preexisting += 1;
          rowBlocks = false;
        } else {
          meaning = "pre-existing";
          preexisting += 1;
          rowBlocks = true;
        }
      } else {
        meaning = "regression";
        regressions += 1;
        rowBlocks = true;
      }
    } else {
      meaning = "unknown";
      unknown += 1;
      rowBlocks = true;
    }

    if (rowBlocks) blocks = true;
    rows.push({
      title: row.title,
      file: row.file,
      changed: "fail",
      baseline: baselineOutcome,
      sameError,
      meaning,
      blocks: rowBlocks,
      inOwnScenario: own,
    });
  }

  const ownPassed = ownScenarioPassed(changed, selection);
  const ownRan = ownScenarioRan(changed, selection);
  if (!ownRan || !ownPassed) blocks = true;

  return {
    equivalent: true,
    inconclusive: false,
    reason: "",
    rows,
    summary: { regressions, preexisting, unknown },
    blocks,
    ownScenarioPassed: ownPassed,
    ownScenarioRan: ownRan,
  };
}

module.exports = {
  collectRunConfig,
  configsEquivalent,
  failedTestArgs,
  compareBaseline,
  ownScenarioRan,
  ownScenarioPassed,
  inSelection,
};
