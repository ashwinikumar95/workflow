const { Octokit } = require("@octokit/rest");

function pullNumberFromUrl(url) {
  const match = String(url || "").match(/\/pull\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : 0;
}

function clientFor(args, client) {
  return client || new Octokit({ auth: args && args.token, baseUrl: "https://api.github.com" });
}

/**
 * Open a pull request, or return the URL of the open request for this head.
 * This module has no merge function.
 * @param {{ owner: string, repo: string, title: string, head: string, base: string, body?: string, token?: string }} args
 * @param {{ pulls: { list: Function, create: Function, update?: Function } }} [client]
 */
async function openPullRequest(args, client) {
  const owner = args && args.owner;
  const repo = args && args.repo;
  const head = args && args.head;
  const base = args && args.base;
  if (!owner || !repo || !head || !base) {
    throw new Error("Pull request requires owner, repo, head, and base");
  }
  const octokit = clientFor(args, client);
  const listed = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    state: "open",
    per_page: 1,
  });
  const existing = listed && listed.data && listed.data[0];
  if (existing && existing.html_url) {
    if (typeof args.body === "string" && args.body && octokit.pulls && typeof octokit.pulls.update === "function") {
      await octokit.pulls.update({
        owner,
        repo,
        pull_number: existing.number,
        body: args.body,
      });
    }
    return existing.html_url;
  }

  const created = await octokit.pulls.create({
    owner,
    repo,
    title: args.title || head,
    head,
    base,
    body: args.body || "",
  });
  if (!created || !created.data || !created.data.html_url) {
    throw new Error("GitHub did not return a pull request URL");
  }
  return created.data.html_url;
}

/**
 * Update the body of an existing pull request so two PRs can link to each other.
 */
async function updatePullRequestBody(args, client) {
  const owner = args && args.owner;
  const repo = args && args.repo;
  const number = Number(args && args.pullNumber) || pullNumberFromUrl(args && args.url);
  if (!owner || !repo || !number) return false;
  if (typeof args.body !== "string") return false;
  const octokit = clientFor(args, client);
  await octokit.pulls.update({
    owner,
    repo,
    pull_number: number,
    body: args.body,
  });
  return true;
}

module.exports = { openPullRequest, updatePullRequestBody, pullNumberFromUrl };
