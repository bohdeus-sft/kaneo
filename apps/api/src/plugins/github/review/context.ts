import type { getVerifiedInstallationOctokit } from "../utils/github-app";
import type { ReviewJob } from "./queue";

type GitHubClient = Awaited<ReturnType<typeof getVerifiedInstallationOctokit>>;
type File = {
  filename: string;
  status: string;
  patch?: string;
  changes: number;
};
const contextBudget = 90_000;
const privatePath =
  /(?:^|\/)(?:\.env(?:\.|$)|id_(?:rsa|ed25519)$)|\.(?:pem|key|p12|pfx)$/i;

function redactPrivateKeys(text: string) {
  return text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "[private key removed]",
  );
}

export function buildDiffContext(files: File[], description: string | null) {
  let remaining = contextBudget;
  const changes = [];
  let incomplete = (description?.length ?? 0) > 16_000 || files.length === 0;
  for (const file of files.slice(0, 300)) {
    if (privatePath.test(file.filename)) {
      incomplete = true;
      continue;
    }
    const available = Math.min(remaining, 20_000);
    const patch =
      file.patch && redactPrivateKeys(file.patch).slice(0, available);
    remaining -= patch?.length ?? 0;
    if (patch?.length !== file.patch?.length || (!patch && file.changes > 0))
      incomplete = true;
    changes.push({ path: file.filename, status: file.status, patch });
  }
  return {
    description: description && redactPrivateKeys(description).slice(0, 16_000),
    incomplete: incomplete || files.length > 300,
    changes,
  };
}

export async function readReviewContext(
  github: GitHubClient,
  repository: { owner: string; repo: string; pull_number: number },
  job: ReviewJob,
) {
  const getPull = async () => (await github.rest.pulls.get(repository)).data;
  const pull = await getPull();
  const options = { owner: repository.owner, repo: repository.repo };
  if (job.kind === "pull_request") {
    if (pull.state !== "open" || pull.head.sha !== job.revision) return null;
    const files = await github.paginate(github.rest.pulls.listFiles, {
      ...repository,
      per_page: 100,
    });
    // Compare the latest head again because listFiles reads a mutable PR.
    const current = await getPull();
    if (current.state !== "open" || current.head.sha !== job.revision)
      return null;
    if (current.base.sha !== pull.base.sha)
      throw new Error("PR base changed while fetching the diff");
    return {
      pull,
      files,
      incomplete: files.length < pull.changed_files,
      stillCurrent: async () => {
        const currentPull = await getPull();
        if (
          currentPull.state !== "open" ||
          currentPull.head.sha !== job.revision
        )
          return false;
        if (currentPull.base.sha !== pull.base.sha)
          throw new Error("PR base changed during review");
        return true;
      },
      scope: "Full proposed PR diff against its GitHub base.",
    };
  }

  if (!pull.merged || pull.merge_commit_sha !== job.revision) return null;
  const { data: commit } = await github.rest.repos.getCommit({
    ...options,
    ref: job.revision,
    per_page: 100,
  });
  const parent = commit.parents[0]?.sha;
  if (!parent) throw new Error("Merge commit has no first parent");
  const { data: comparison } =
    await github.rest.repos.compareCommitsWithBasehead({
      ...options,
      basehead: `${parent}...${job.revision}`,
    });
  const files = comparison.files ?? [];
  const surroundingCode = [];
  for (const file of files
    .filter(
      (file) =>
        file.status !== "removed" &&
        file.patch &&
        !privatePath.test(file.filename),
    )
    .slice(0, 3)) {
    try {
      const { data } = await github.rest.repos.getContent({
        ...options,
        path: file.filename,
        ref: job.revision,
      });
      if (
        !Array.isArray(data) &&
        data.type === "file" &&
        data.encoding === "base64" &&
        data.size <= 24_000
      ) {
        surroundingCode.push({
          path: file.filename,
          code: redactPrivateKeys(
            Buffer.from(data.content, "base64").toString("utf8"),
          ),
        });
      }
    } catch {
      // The actual merge diff remains available when the surrounding file cannot be read.
    }
  }
  const possiblyRebased = commit.parents.length === 1 && pull.commits > 1;
  return {
    pull,
    files,
    surroundingCode,
    incomplete: files.length >= 300 || possiblyRebased,
    stillCurrent: async () => true,
    scope: possiblyRebased
      ? "Delta from the final commit's first parent. A rebase may have applied earlier commits separately, so this evidence cannot establish the entire merge result."
      : "Actual changes from the merge commit's first parent to the merge result.",
  };
}
