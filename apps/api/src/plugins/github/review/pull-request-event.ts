import type { GitHubConfig } from "../config";
import { findExternalLink } from "../services/link-manager";
import { findAllIntegrationsByRepo } from "../services/task-service";
import { withIntegrationLink } from "../services/with-integration-link";
import { getReviewProvider } from "./config";
import { enqueueReview, type ReviewJob } from "./queue";

type ReviewEvent = {
  installation?: { id: number };
  repository: { id: number; owner: { login: string }; name: string };
  pull_request: {
    number: number;
    state: string;
    merged?: boolean | null;
    merge_commit_sha?: string | null;
    head: { sha: string };
  };
};

export async function handleReviewEvent(
  payload: ReviewEvent,
  kind: ReviewJob["kind"],
  linkPullRequest?: () => Promise<void>,
) {
  const { pull_request: pull } = payload;
  if (kind === "merge" ? !pull.merged : pull.state !== "open") return;
  const revision = kind === "merge" ? pull.merge_commit_sha : pull.head.sha;
  if (!revision || !getReviewProvider()) return;

  const integrations = (await findAllIntegrationsByRepo(payload)).map(
    (integration) => ({
      integration,
      model: (JSON.parse(integration.config) as GitHubConfig).aiReviewModel,
    }),
  );
  if (!integrations.some(({ model }) => model)) return;

  async function linkedPullRequests() {
    const links = await Promise.all(
      integrations.map(async (candidate) => ({
        ...candidate,
        link: await findExternalLink(
          candidate.integration.id,
          "pull_request",
          String(pull.number),
        ),
      })),
    );
    return links.filter(({ link }) => link);
  }

  let candidates = await linkedPullRequests();
  if (candidates.length === 0 && linkPullRequest) {
    await linkPullRequest();
    candidates = await linkedPullRequests();
  }
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate?.model || !candidate.link) return;
  const { integration, link } = candidate;
  await withIntegrationLink(
    link,
    integration,
    (database) => enqueueReview(database, link.id, kind, revision),
    { type: "github", config: integration.config },
  );
}
