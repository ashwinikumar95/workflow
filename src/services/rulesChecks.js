const fs = require("fs");
const path = require("path");
const git = require("./gitService");
const { matchGlob } = require("./rulesService");
const { reviewSchema } = require("./agentContract");

const CHECKS_DIR = path.join(__dirname, "..", "..", "config", "rules-checks");

function posix(file) {
  return String(file || "").replace(/\\/g, "/");
}

function loadChecksFile(repo, dir = CHECKS_DIR) {
  const name = String(repo || "").trim();
  if (!name) return { repo: "", enabled: false, checks: [] };
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) return { repo: name, enabled: false, checks: [] };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const checks = Array.isArray(raw.checks) ? raw.checks : [];
  return {
    repo: raw.repo || name,
    enabled: raw.enabled !== false,
    checks,
  };
}

function enabledChecks(config) {
  if (!config || config.enabled === false) return [];
  return (config.checks || []).filter((check) => check && check.enabled !== false);
}

function parseAddedLines(diff) {
  const files = [];
  let current = null;
  for (const line of String(diff || "").split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = { path: posix(fileMatch[2]), added: [] };
      files.push(current);
      continue;
    }
    const plusFile = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusFile && current) current.path = posix(plusFile[1]);
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return files.filter((file) => file.path && file.path !== "/dev/null");
}

async function addedDiff(worktreePath, fromSha, toSha) {
  if (!worktreePath || !fromSha) return [];
  const args = ["-C", worktreePath, "diff", "-U0", fromSha];
  if (toSha) args.push(toSha);
  try {
    const result = await git.runGit(args);
    return parseAddedLines(result && result.stdout);
  } catch (err) {
    if (err && err.code === 1 && err.stdout != null) return parseAddedLines(err.stdout);
    throw err;
  }
}

function fileMatches(check, filePath) {
  const globs = Array.isArray(check.globs) && check.globs.length ? check.globs : ["**/*"];
  return globs.some((glob) => matchGlob(glob, filePath));
}

function runMechanicalChecks({ files, checks } = {}) {
  const list = Array.isArray(files) ? files : [];
  const active = Array.isArray(checks) ? checks.filter((check) => check && check.enabled !== false) : [];
  const violations = [];
  for (const check of active) {
    let pattern;
    try {
      pattern = new RegExp(check.pattern, check.flags || "");
    } catch {
      continue;
    }
    for (const file of list) {
      const filePath = posix(file.path || file.file || "");
      if (!filePath || !fileMatches(check, filePath)) continue;
      const added = Array.isArray(file.added) ? file.added : Array.isArray(file.addedLines) ? file.addedLines : [];
      added.forEach((line, index) => {
        if (pattern.test(line)) {
          violations.push({
            id: check.id,
            rule: check.rule,
            severity: check.severity || "medium",
            file: filePath,
            line: index + 1,
            detail: check.message || check.id,
            evidence: line,
          });
        }
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

function textOf(item, keys) {
  if (!item || typeof item !== "object") return "";
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function severityOf(item) {
  const severity = item && item.severity;
  return severity === "high" || severity === "medium" || severity === "low" ? severity : "medium";
}

function locationFrom(item) {
  const explicitFile = textOf(item, ["file"]);
  const explicitLine = item && Number.isInteger(item.line) && item.line >= 0 ? item.line : undefined;
  const blob = [item && item.evidence, item && item.finding, item && item.detail].filter(Boolean).join("\n");
  const withLine = blob.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)/);
  const fileOnly = blob.match(/([A-Za-z0-9_./\\-]+\.(?:vue|js|jsx|ts|tsx|json|md|css|scss))/);
  const file = explicitFile || (withLine && withLine[1].replace(/\\/g, "/")) || (fileOnly && fileOnly[1].replace(/\\/g, "/")) || "";
  const line = explicitLine !== undefined ? explicitLine : withLine ? Number(withLine[2]) : undefined;
  return { file, line };
}

function potentialItem(item, extra = {}) {
  const located = locationFrom(item);
  const row = {
    rule: textOf(item, ["rule"]) || "unspecified",
    detail: textOf(item, ["detail", "finding", "message", "description"]) || extra.detail || "Missing detail",
    severity: severityOf(item),
    whatWouldConfirm: textOf(item, ["whatWouldConfirm"]) || extra.whatWouldConfirm || "Quote the matching diff line as evidence",
  };
  const file = located.file;
  if (file) row.file = file;
  if (located.line !== undefined) row.line = located.line;
  const evidence = textOf(item, ["evidence"]);
  if (evidence) row.evidence = evidence;
  return row;
}

function coerceConfirmed(item) {
  const evidence = textOf(item, ["evidence"]);
  const located = locationFrom(item);
  const detail = textOf(item, ["detail", "finding", "message", "description"]);
  if (!evidence || !located.file || located.line === undefined) {
    return {
      bucket: "potential",
      item: potentialItem(item, {
        detail: detail || "Missing quoted evidence",
        whatWouldConfirm: "Quote the matching diff line as evidence",
      }),
    };
  }
  return {
    bucket: "confirmed",
    item: {
      rule: textOf(item, ["rule"]) || "unspecified",
      file: located.file,
      line: located.line,
      detail: detail || "Missing detail",
      severity: severityOf(item),
      evidence,
    },
  };
}

function coerceUncertainty(item) {
  if (typeof item === "string" && item.trim()) return { rule: "unspecified", question: item.trim() };
  if (!item || typeof item !== "object") return null;
  const question = textOf(item, ["question", "finding", "detail", "message"]);
  if (!question) return null;
  return { rule: textOf(item, ["rule"]) || "unspecified", question };
}

function normalizeReview(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const confirmed = [];
  const potential = [];
  for (const item of Array.isArray(input.confirmed) ? input.confirmed : []) {
    if (!item || typeof item !== "object") continue;
    const coerced = coerceConfirmed(item);
    if (coerced.bucket === "confirmed") confirmed.push(coerced.item);
    else potential.push(coerced.item);
  }
  for (const item of Array.isArray(input.potential) ? input.potential : []) {
    if (!item || typeof item !== "object") continue;
    potential.push(potentialItem(item));
  }
  const uncertainties = [];
  for (const item of Array.isArray(input.uncertainties) ? input.uncertainties : []) {
    const coerced = coerceUncertainty(item);
    if (coerced) uncertainties.push(coerced);
  }
  const candidate = { confirmed, potential, uncertainties };
  const checked = reviewSchema.safeParse(candidate);
  if (!checked.success) return { ok: false, reason: "schema", value: candidate };
  return { ok: true, value: checked.data };
}

function lastAttempt(options = {}) {
  const attempt = Number(options.attempt) || 1;
  const maxFixAttempts = Number(options.maxFixAttempts) || 1;
  return attempt >= maxFixAttempts;
}

function applyReviewBlocking(review, options = {}) {
  const mechanicalFailed = Boolean(options.mechanicalFailed);
  const isLast = lastAttempt(options);
  const confirmed = (review && review.confirmed) || [];
  const potential = (review && review.potential) || [];
  const uncertainties = (review && review.uncertainties) || [];

  if (options.invalidReview) {
    if (options.alreadyRetried) return { action: "block", reason: "invalid_review" };
    return { action: "retry", reason: "invalid_review" };
  }
  if (uncertainties.length) {
    return { action: "wait", reason: "uncertainty", findings: uncertainties };
  }
  if (mechanicalFailed) {
    return { action: isLast ? "block" : "retry", reason: "mechanical" };
  }
  const confirmedHighMed = confirmed.filter((item) => item.severity === "high" || item.severity === "medium");
  if (confirmedHighMed.length) {
    return { action: isLast ? "block" : "retry", reason: "confirmed", findings: confirmedHighMed };
  }
  const potentialHigh = potential.filter((item) => item.severity === "high");
  if (potentialHigh.length) {
    if (options.deviationApproved) {
      return {
        action: "proceed",
        reason: "potential_high_approved",
        deviations: potentialHigh,
      };
    }
    if (!isLast) return { action: "retry", reason: "potential_high", findings: potentialHigh };
    return { action: "block", reason: "potential_high", findings: potentialHigh };
  }
  const confirmedLow = confirmed.filter((item) => item.severity === "low");
  if (confirmedLow.length && !isLast && attemptOnce(options, "confirmed_low")) {
    return { action: "retry", reason: "confirmed_low", findings: confirmedLow };
  }
  const deviations = confirmedLow.concat(potential.filter((item) => item.severity !== "high"));
  return { action: "proceed", reason: "ok", deviations };
}

function attemptOnce(options, key) {
  const seen = options.retried || {};
  return !seen[key];
}

function reviewValidationDecision(parseResult, options = {}) {
  if (parseResult && parseResult.ok) return { action: "continue", review: parseResult.value };
  if (!options.alreadyRetried) return { action: "retry", reason: "invalid_review" };
  return { action: "block", reason: "invalid_review" };
}

module.exports = {
  CHECKS_DIR,
  loadChecksFile,
  enabledChecks,
  parseAddedLines,
  addedDiff,
  runMechanicalChecks,
  normalizeReview,
  applyReviewBlocking,
  reviewValidationDecision,
};
