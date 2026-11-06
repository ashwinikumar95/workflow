const fs = require("fs");
const path = require("path");

const LOCKFILES = [
  { file: "pnpm-lock.yaml", manager: "pnpm", command: ["pnpm", "install", "--frozen-lockfile"] },
  { file: "package-lock.json", manager: "npm", command: ["npm", "ci"] },
  { file: "yarn.lock", manager: "yarn", command: ["yarn", "install", "--immutable"] },
];

function detectPackageManager(dir) {
  const present = LOCKFILES.filter((entry) => fs.existsSync(path.join(dir, entry.file)));
  if (present.length !== 1) {
    return {
      status: "bootstrap-failed",
      failureClass: "bootstrap",
      branch: "false",
      reason: present.length === 0 ? "no-lockfile" : "multiple-lockfiles",
    };
  }
  const chosen = present[0];
  const packagePath = path.join(dir, "package.json");
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (typeof pkg.packageManager === "string" && pkg.packageManager.length > 0) {
        const named = pkg.packageManager.split("@")[0];
        if (named !== chosen.manager) {
          return {
            status: "bootstrap-failed",
            failureClass: "bootstrap",
            branch: "false",
            reason: "package-manager-mismatch",
          };
        }
      }
    } catch {
      return {
        status: "bootstrap-failed",
        failureClass: "bootstrap",
        branch: "false",
        reason: "package-json",
      };
    }
  }
  return { manager: chosen.manager, command: chosen.command.slice() };
}

function classifyPlaywrightOutcome({
  lockfileError,
  installCode,
  browserCode,
  timedOut,
  testCode,
  reportPresent,
  failureClass,
  reason,
}) {
  if (failureClass === "env" || reason === "env") {
    return {
      status: "failed",
      failureClass: "env",
      branch: "false",
      reportPresent: false,
      reason: reason || "env",
    };
  }
  if (lockfileError) {
    return {
      status: "bootstrap-failed",
      failureClass: "bootstrap",
      branch: "false",
      reportPresent: false,
    };
  }
  if (installCode !== 0 && installCode !== undefined && installCode !== null) {
    return {
      status: "bootstrap-failed",
      failureClass: "bootstrap",
      branch: "false",
      reportPresent: false,
    };
  }
  if (browserCode !== 0 && browserCode !== undefined && browserCode !== null) {
    return {
      status: "bootstrap-failed",
      failureClass: "bootstrap",
      branch: "false",
      reportPresent: false,
    };
  }
  if (timedOut) {
    return {
      status: "timed-out",
      failureClass: "timeout",
      branch: "false",
      reportPresent: false,
    };
  }
  if (reportPresent !== true) {
    return {
      status: "failed",
      failureClass: "missing-report",
      branch: "false",
      reportPresent: false,
    };
  }
  if (testCode !== 0) {
    return {
      status: "failed",
      failureClass: "tests",
      branch: "false",
      reportPresent: true,
    };
  }
  return {
    status: "passed",
    failureClass: null,
    branch: "true",
    reportPresent: true,
  };
}

function resolvePlaywrightLayout({ strategy, appWorktree, testWorktree }) {
  if (strategy === "in-repo") {
    return { testCwd: appWorktree, appCwd: appWorktree };
  }
  if (strategy === "external-repo") {
    return { testCwd: testWorktree, appCwd: appWorktree };
  }
  throw new Error("Playwright strategy is required");
}

/**
 * `deployed-preview` is a required configuration choice and is not implemented.
 * It fails closed. It does not fall back to a shared preview.
 */
function planTarget(target) {
  if (target === "local-worktree") return { boot: "local-worktree" };
  if (target === "deployed-preview") {
    return {
      boot: null,
      status: "bootstrap-failed",
      failureClass: "bootstrap",
      branch: "false",
      reason: "preview-unverified",
    };
  }
  throw new Error("Playwright target is required");
}

module.exports = {
  detectPackageManager,
  classifyPlaywrightOutcome,
  resolvePlaywrightLayout,
  planTarget,
};
