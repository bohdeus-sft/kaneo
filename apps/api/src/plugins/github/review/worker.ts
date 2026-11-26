import { safeParse } from "valibot";
import { and, eq } from "drizzle-orm";
import db from "../../../database";
import {
  externalLinkTable,
  githubReviewTable,
  integrationTable,
  taskTable,
} from "../../../database/schema";
import { activeIntegrationCondition } from "../../active-integration-condition";
import { githubConfigSchema, hasVerifiedGitHubBinding } from "../config";
import { withIntegrationLink } from "../services/with-integration-link";
import { getVerifiedInstallationOctokit } from "../utils/github-app";
import { analyzeReview, formatReview } from "./analyze";
import { getReviewProvider, type ReviewProvider } from "./config";
import { buildDiffContext, readReviewContext } from "./context";
import { claimReview, currentClaim, MAX_REVIEW_ATTEMPTS } from "./queue";
import { saveReviewReport } from "./report";

export async function processReview(config: ReviewProvider) {
  const job = await claimReview();
  if (!job) return;
  const [target] = await db
    .select({
      link: externalLinkTable,
      integration: integrationTable,
      taskTitle: taskTable.title,
      taskDescription: taskTable.description,
    })
    .from(externalLinkTable)
    .innerJoin(
      integrationTable,
      eq(externalLinkTable.integrationId, integrationTable.id),
    )
    .innerJoin(
      taskTable,
      and(
        eq(externalLinkTable.taskId, taskTable.id),
        eq(taskTable.projectId, integrationTable.projectId),
      ),
    )
    .where(
      and(
        eq(externalLinkTable.id, job.linkId),
        eq(integrationTable.type, "github"),
        activeIntegrationCondition(),
      ),
    );

  const complete = async () => {
    await db
      .update(githubReviewTable)
      .set({ completedAt: new Date() })
      .where(currentClaim(job));
  };

  if (!target) return complete();
  const { integration, link } = target;
  const parsed = safeParse(githubConfigSchema, JSON.parse(integration.config));
  if (!parsed.success || !hasVerifiedGitHubBinding(parsed.output))
    return complete();
  const configuration = parsed.output;
  const owner = configuration.repositoryOwner;
  const repo = configuration.repositoryName;
  const model = configuration.aiReviewModel;
  if (!model) return complete();

  const heading =
    job.kind === "merge"
      ? "AI review after merge"
      : "AI review of pull request";
  let report: string;
  try {
    if (job.attempts > MAX_REVIEW_ATTEMPTS)
      throw new Error("Review attempts exhausted");
    const github = await getVerifiedInstallationOctokit(configuration, true);
    const context = await readReviewContext(
      github,
      { owner, repo, pull_number: Number(link.externalId) },
      job,
    );
    if (!context) return complete();
    const diff = buildDiffContext(context.files, target.taskDescription);
    const incomplete = diff.incomplete || context.incomplete;
    const result = await analyzeReview(
      { ...config, model },
      JSON.stringify({
        phase: job.kind,
        task: { title: target.taskTitle, description: diff.description },
        pullRequest: {
          title: context.pull.title,
          targetBranch: context.pull.base.ref,
          revision: job.revision,
        },
        scope: context.scope,
        incomplete,
        changes: diff.changes,
        mergedFiles:
          "surroundingCode" in context ? context.surroundingCode : undefined,
      }),
    );
    if (!(await context.stillCurrent())) return complete();
    report = [
      job.kind === "merge"
        ? `GitHub merged the PR into **${context.pull.base.ref}**.`
        : "",
      incomplete ? `Review coverage is limited. ${context.scope}` : "",
      formatReview(result),
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    if (job.attempts < MAX_REVIEW_ATTEMPTS) {
      await db
        .update(githubReviewTable)
        .set({ nextAttemptAt: new Date(Date.now() + 15_000 * job.attempts) })
        .where(currentClaim(job));
      return;
    }
    report =
      job.kind === "merge"
        ? "GitHub confirmed the merge. AI analysis could not be completed. Inspect the merge diff and the affected code paths."
        : "AI analysis could not be completed. Inspect the PR diff against the task requirements.";
  }

  const saved = await withIntegrationLink(
    link,
    integration,
    async (database, afterCommit) => {
      const [claimed] = await database
        .update(githubReviewTable)
        .set({ completedAt: new Date() })
        .where(currentClaim(job))
        .returning({ id: githubReviewTable.id });
      if (!claimed) return true;

      await saveReviewReport(database, afterCommit, {
        taskId: link.taskId,
        projectId: integration.projectId,
        source:
          job.kind === "merge" ? "github-merge-review" : "github-pr-review",
        url: link.url,
        content: `**${heading}** · \`${job.revision.slice(0, 12)}\`\n\n${report}`,
      });
      return true;
    },
    { type: "github", config: integration.config },
  );

  if (!saved) await complete();
}

export function startGitHubReviewWorker() {
  const config = getReviewProvider();
  if (!config) return async () => {};
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = processReview(config)
      .catch(() => {
        console.error("GitHub AI review worker failed");
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 2_000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
