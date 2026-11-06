/**
 * Runtime gate. Throws before push or GitHub when the predecessor pass is missing.
 */
function gateSource(external, role) {
  if (external && external.repos && typeof external.repos === "object") {
    if (role && external.repos[role]) return external.repos[role];
    return null;
  }
  return external || null;
}

function playwrightMap(external, source) {
  const fromRole = source && source.playwrightByNode;
  const fromFlat = external && external.playwrightByNode;
  if (fromRole && typeof fromRole === "object" && fromFlat && typeof fromFlat === "object") {
    return { ...fromFlat, ...fromRole };
  }
  return fromRole || fromFlat || null;
}

function entrySha(entry, role) {
  if (entry && entry.testedShas && role && entry.testedShas[role]) return entry.testedShas[role];
  return entry && entry.testedSha;
}

function findPassedEntry(map, tested, role) {
  if (!map || typeof map !== "object") return null;
  for (const entry of Object.values(map)) {
    if (!entry || entry.status !== "passed" || entry.reportPresent !== true) continue;
    const sha = entrySha(entry, role);
    if (tested && sha === tested) return entry;
  }
  return null;
}

function assertPullRequestGate({ external, predecessorId, head, role }) {
  const source = gateSource(external, role);
  const map = playwrightMap(external, source);
  let entry = map && predecessorId ? map[predecessorId] : undefined;
  const tested = source && source.testedSha;
  if (!entry || entry.status !== "passed" || entry.reportPresent !== true) {
    entry = findPassedEntry(map, tested, role);
  }
  if (!entry || entry.status !== "passed" || entry.reportPresent !== true) {
    throw new Error("Pull request gate rejected");
  }
  const testedFromEntry = entrySha(entry, role);
  if (!tested || testedFromEntry !== tested || tested !== head) {
    throw new Error("Pull request gate rejected");
  }
}

module.exports = { assertPullRequestGate };
