const { Octokit } = require("@octokit/rest");

/**
 * Open a pull request, or return the URL of the open request for this head.
 * This module has no merge function.
 * @param {{ owner: string, repo: string, title: string, head: string, base: string, body?: string, token?: string }} args
 * @param {{ pulls: { list: Function, create: Function } }} [client]
 */
async function openPullRequest(args, client) {
  const owner = args && args.owner;
  const repo = args && args.repo;
  const head = args && args.head;
  const base = args && args.base;
  if (!owner || !repo || !head || !base) {
    throw new Error("Pull request requires owner, repo, head, and base");
  }
  const octokit = client || new Octokit({ auth: args.token, baseUrl: "https://api.github.com" });
  const listed = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    state: "open",
    per_page: 1,
  });
  const existing = listed && listed.data && listed.data[0];
  if (existing && existing.html_url) return existing.html_url;

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

module.exports = { openPullRequest };
