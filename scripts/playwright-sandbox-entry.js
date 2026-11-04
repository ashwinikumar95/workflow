"use strict";

const { spawn } = require("child_process");

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

/**
 * Install, browser install, then the suite. Each step is separate so a missing
 * install or browser is not reported as a test failure.
 */
async function main() {
  const cwd = process.env.PLAYWRIGHT_CWD || "/tests";
  const install = JSON.parse(process.env.PLAYWRIGHT_INSTALL || "[]");
  const browsers = JSON.parse(process.env.PLAYWRIGHT_BROWSERS || "[]");
  const suite = JSON.parse(process.env.PLAYWRIGHT_COMMAND || "[\"test\"]");
  if (install.length > 0) {
    const installed = await run(install[0], install.slice(1), cwd);
    if (installed.code !== 0) {
      process.stdout.write(JSON.stringify({ step: "install", code: installed.code }));
      process.exit(installed.code);
    }
  }
  if (browsers.length > 0) {
    const browser = await run(browsers[0], browsers.slice(1), cwd);
    if (browser.code !== 0) {
      process.stdout.write(JSON.stringify({ step: "browsers", code: browser.code }));
      process.exit(browser.code);
    }
  }
  const tested = await run(suite[0], suite.slice(1), cwd);
  process.stdout.write(JSON.stringify({ step: "test", code: tested.code }));
  process.exit(tested.code);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(err && err.message ? err.message : "playwright sandbox failed");
    process.exit(1);
  });
}

module.exports = { main, run };
