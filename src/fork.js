// Where this fork's releases come from.
//
// Upstream publishes to npm. This fork (jerots/claude-multiprofile) is
// installed from its GitHub repository instead, and its versions carry a
// `-jerots.N` suffix. Checking npm from the fork is wrong both ways: `upgrade`
// would replace the fork with upstream, and `doctor` would report upstream's
// releases as updates the fork cannot take. So both ask the repository.
//
// The latest release is whatever version the head of `main` declares. It is
// installed pinned to that commit, never to the moving branch, so what gets
// installed is exactly the commit that was shown and confirmed.

import { execFileSync } from "node:child_process";

export const FORK_REPO = "jerots/claude-multiprofile";
const FORK_BRANCH = "main";

export function isForkVersion(version) {
  return /-jerots\.\d+$/.test(String(version));
}

export function forkInstallSpec(sha) {
  return `github:${FORK_REPO}#${sha}`;
}

export function forkCommitUrl(sha) {
  return `https://github.com/${FORK_REPO}/commit/${sha}`;
}

// curl ships with macOS, and keeps this synchronous like doctor's other
// checks. Unauthenticated GitHub API calls are rate-limited (60 an hour),
// plenty for a command run by hand.
function curlJson(url) {
  const out = execFileSync("curl", ["-fsSL", "--max-time", "15", "-H", "Accept: application/vnd.github+json", url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}

// { version, sha, message, date } for the head of the fork's main branch, or
// null when GitHub cannot be reached or the answer does not make sense.
export function fetchForkLatest() {
  try {
    const commit = curlJson(`https://api.github.com/repos/${FORK_REPO}/commits/${FORK_BRANCH}`);
    const sha = commit && commit.sha;
    if (!/^[0-9a-f]{40}$/.test(sha || "")) return null;
    const pkg = curlJson(`https://raw.githubusercontent.com/${FORK_REPO}/${sha}/package.json`);
    if (!pkg || typeof pkg.version !== "string") return null;
    return {
      version: pkg.version,
      sha,
      message: String(commit.commit?.message || "").split("\n")[0],
      date: String(commit.commit?.committer?.date || "").slice(0, 10),
    };
  } catch {
    return null;
  }
}
