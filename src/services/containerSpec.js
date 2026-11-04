const config = require("../../config");
const { FORBIDDEN_ENV, assertEnvAllowed } = require("./forbiddenEnv");

function assertPinnedImage(image) {
  if (typeof image !== "string" || !/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error("PLAYWRIGHT_IMAGE must be pinned by digest");
  }
}

function assertEgress(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error("CURSOR_EGRESS_HOSTS is empty");
  }
}

function buildAgentContainerSpec({
  worktreePath,
  agentExecutionId,
  apiKey,
  model,
  memory,
  cpus,
  pids,
  egressHosts,
  image,
  runtime,
}) {
  assertEgress(egressHosts);
  if (!worktreePath) throw new Error("Agent container requires a worktree");
  if (!agentExecutionId) throw new Error("Agent container requires an execution id");
  const name = `wf-agent-${agentExecutionId}`;
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/agent",
    CURSOR_API_KEY: apiKey || "",
    CURSOR_MODEL: model || config.cursorModel || "composer-2.5",
    GIT_CONFIG_GLOBAL: "/home/agent/.gitconfig",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  assertEnvAllowed(env);
  const mounts = [
    { type: "bind", src: worktreePath, dst: "/worktree", readonly: false },
    { type: "tmpfs", dst: "/tmp" },
    { type: "tmpfs", dst: "/home/agent" },
  ];
  const args = [
    "run",
    "--name",
    name,
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(pids || config.agentPids),
    "--memory",
    String(memory || config.agentMemory),
    "--cpus",
    String(cpus || config.agentCpus),
    "--network",
    "wf-agent-egress",
    "--mount",
    `type=bind,src=${worktreePath},dst=/worktree`,
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home/agent",
  ];
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(image || "workflow-agent:local", "node", "/opt/sandbox/agent-sandbox-entry.mjs");
  if (args.includes("--network=host") || args.includes("--network") && args[args.indexOf("--network") + 1] === "host") {
    throw new Error("--network=host is forbidden");
  }
  for (const name of FORBIDDEN_ENV) {
    if (args.some((arg) => String(arg).includes(name))) {
      throw new Error(`Forbidden value in container arguments: ${name}`);
    }
  }
  return {
    runtime: runtime || config.agentRuntime || "docker",
    name,
    args,
    env,
    mounts,
    network: "wf-agent-egress",
  };
}

function buildPlaywrightEnv({ baseUrl, gitCommit, extraAllow, browsersPath }) {
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    CI: "1",
    BASE_URL: baseUrl || "",
    GIT_COMMIT: gitCommit || "",
    PLAYWRIGHT_BROWSERS_PATH: browsersPath || config.playwrightBrowsersPath || "",
  };
  const allow = Array.isArray(extraAllow) ? extraAllow : config.playwrightEnvAllow;
  for (const name of allow) {
    if (FORBIDDEN_ENV.includes(name)) continue;
    if (Object.prototype.hasOwnProperty.call(env, name)) continue;
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  assertEnvAllowed(env);
  return env;
}

function buildPlaywrightContainerSpec({
  image,
  testCwd,
  appWorktree,
  strategy,
  env,
  memory,
  cpus,
  runtime,
}) {
  assertPinnedImage(image);
  assertEnvAllowed(env);
  const mounts = [{ type: "bind", src: testCwd, dst: "/tests", readonly: false }];
  if (strategy === "external-repo" && appWorktree) {
    mounts.push({ type: "bind", src: appWorktree, dst: "/app", readonly: true });
  }
  const args = [
    "run",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    String(memory || config.playwrightMemory),
    "--cpus",
    String(cpus || config.playwrightCpus),
    "--network",
    "wf-playwright",
    "--mount",
    `type=bind,src=${testCwd},dst=/tests`,
  ];
  if (strategy === "external-repo" && appWorktree) {
    args.push("--mount", `type=bind,src=${appWorktree},dst=/app,readonly`);
  }
  for (const [key, value] of Object.entries(env || {})) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(image, "node", "/opt/sandbox/playwright-sandbox-entry.js");
  for (const name of FORBIDDEN_ENV) {
    if (args.some((arg) => String(arg).includes(`${name}=`) || arg === name)) {
      throw new Error(`Forbidden value in container arguments: ${name}`);
    }
  }
  if (args.includes("--network=host")) throw new Error("--network=host is forbidden");
  return {
    runtime: runtime || config.agentRuntime || "docker",
    args,
    env,
    mounts,
  };
}

module.exports = {
  assertPinnedImage,
  assertEgress,
  buildAgentContainerSpec,
  buildPlaywrightEnv,
  buildPlaywrightContainerSpec,
};
