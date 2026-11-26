import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { githubReviewTable } from "../../apps/api/src/database/schema";
import { getReviewProvider } from "../../apps/api/src/plugins/github/review/config";
import { handleReviewEvent } from "../../apps/api/src/plugins/github/review/pull-request-event";
import { processReview } from "../../apps/api/src/plugins/github/review/worker";
import { handleIssueCommentCreated } from "../../apps/api/src/plugins/github/webhooks/issue-comment-created";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const api = vi.hoisted(() => ({
  pull: vi.fn(),
  files: vi.fn(),
  commit: vi.fn(),
  compare: vi.fn(),
  content: vi.fn(),
}));
vi.mock("../../apps/api/src/events", () => ({
  publishEvent: vi.fn(async () => {}),
}));
vi.mock("../../apps/api/src/plugins/github/utils/github-app", () => ({
  getVerifiedInstallationOctokit: async () => ({
    paginate: api.files,
    rest: {
      pulls: { get: api.pull, listFiles: vi.fn() },
      repos: {
        getCommit: api.commit,
        compareCommitsWithBasehead: api.compare,
        getContent: api.content,
      },
    },
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("reviews new commits, records actual merge changes, and imports rejected merges", async () => {
  await resetTestDatabase();
  vi.stubEnv("KANEO_AI_REVIEW_PROVIDER", "openai");
  vi.stubEnv("OPENAI_BASE_URL", "https://sub2api.example.com/v1");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  const { user, workspace } = await createWorkspaceMember();
  const { project } = await createProjectFixture({ workspaceId: workspace.id });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      number: 1,
      title: "Test task",
      description: "Handle a missing value.",
      status: "in-review",
    })
    .returning();
  const source = {
    repository: { id: 20, name: "repo", owner: { login: "owner" } },
    installation: { id: 10 },
  };
  const binding = {
    repositoryId: 20,
    repositoryOwner: "owner",
    repositoryName: "repo",
    installationId: 10,
    verifiedGithubAccountId: "1",
    verifiedByUserId: user.id,
  };
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "github",
      config: JSON.stringify(binding),
    })
    .returning();
  await db.insert(schema.externalLinkTable).values([
    {
      taskId: task.id,
      integrationId: integration.id,
      resourceType: "pull_request",
      externalId: "5",
      url: "https://github.com/owner/repo/pull/5",
    },
    {
      taskId: task.id,
      integrationId: integration.id,
      resourceType: "issue",
      externalId: "6",
      url: "https://github.com/owner/repo/issues/6",
    },
  ]);
  const config = getReviewProvider();
  if (!config) throw new Error("Expected a configured review provider");
  const setModel = async (aiReviewModel: string | null) =>
    db
      .update(schema.integrationTable)
      .set({ config: JSON.stringify({ ...binding, aiReviewModel }) })
      .where(eq(schema.integrationTable.id, integration.id));
  const analyze = vi
    .fn()
    .mockImplementation(async (url: string, options: RequestInit) => {
      expect(url).toBe("https://sub2api.example.com/v1/responses");
      expect(new Headers(options.headers).get("Authorization")).toBe(
        "Bearer test-key",
      );
      const body = JSON.parse(String(options.body));
      expect(body.model).toBe("project-model");
      const input = JSON.parse(body.input);
      expect(input.task.description).toBe("Handle a missing value.");
      return Response.json({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  verdict: "no_findings",
                  summary: input.phase,
                  requirements: [],
                  findings: [],
                }),
              },
            ],
          },
        ],
      });
    });
  vi.stubGlobal("fetch", analyze);
  const file = {
    filename: "app.ts",
    patch: "+return input ?? null;",
    status: "modified",
    changes: 1,
  };
  api.files.mockResolvedValue([file]);
  const comments = () =>
    db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, task.id));
  const reportRevision = async (revision: string) => {
    const pull = {
      number: 5,
      state: "open",
      merged: false,
      head: { sha: revision },
      base: { sha: "a".repeat(40), ref: "stage" },
      changed_files: 1,
    };
    api.pull.mockResolvedValue({ data: pull });
    await handleReviewEvent({ ...source, pull_request: pull }, "pull_request");
    await handleReviewEvent({ ...source, pull_request: pull }, "pull_request");
    await processReview(config);
    await processReview(config);
  };
  await reportRevision("a".repeat(40));
  expect(analyze).not.toHaveBeenCalled();
  await setModel("project-model");
  await reportRevision("a".repeat(40));
  await reportRevision("b".repeat(40));
  expect(analyze).toHaveBeenCalledTimes(2);
  const reviews = await comments();
  expect(reviews).toHaveLength(1);
  expect(reviews[0].content).toContain("bbbbbbbbbbbb");
  const revision = "c".repeat(40);
  const merged = {
    number: 5,
    state: "closed",
    merged: true,
    merge_commit_sha: revision,
    head: { sha: "b".repeat(40) },
    base: { ref: "stage" },
    commits: 1,
  };
  api.pull.mockResolvedValue({ data: merged });
  api.commit.mockResolvedValue({
    data: { parents: [{ sha: "d".repeat(40) }] },
  });
  api.compare.mockResolvedValue({ data: { files: [file] } });
  api.content.mockResolvedValue({ data: [] });
  await handleReviewEvent({ ...source, pull_request: merged }, "merge");
  await processReview(config);
  expect(api.compare).toHaveBeenCalledWith({
    owner: "owner",
    repo: "repo",
    basehead: "d".repeat(40) + "..." + revision,
  });
  const failed = {
    ...source,
    action: "created",
    issue: { number: 6 },
    comment: {
      id: 7,
      body: "<!-- kaneo-merge-failure -->\nResolve the conflict.",
      html_url: "https://github.com/owner/repo/issues/6#issuecomment-7",
      user: { id: 41898282, login: "github-actions[bot]", avatar_url: "" },
      created_at: new Date().toISOString(),
    },
  };
  await handleIssueCommentCreated(failed);
  await handleIssueCommentCreated(failed);
  await setModel(null);
  await reportRevision("e".repeat(40));
  await handleIssueCommentCreated({
    ...failed,
    comment: {
      ...failed.comment,
      html_url: failed.comment.html_url + "-other",
    },
  });
  expect(analyze).toHaveBeenCalledTimes(3);
  const results = await comments();
  expect(results.map((comment) => comment.externalSource).sort()).toEqual([
    "github-merge-failure",
    "github-merge-review",
    "github-pr-review",
  ]);
  expect(await db.select().from(githubReviewTable)).toHaveLength(3);
});
