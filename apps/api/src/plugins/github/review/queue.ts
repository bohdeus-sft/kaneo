import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import db from "../../../database";
import { githubReviewTable } from "../../../database/schema";
import type { IntegrationDatabase } from "../services/integration-task-scope";

export type ReviewJob = typeof githubReviewTable.$inferSelect;
export const MAX_REVIEW_ATTEMPTS = 3;

export async function enqueueReview(
  database: IntegrationDatabase,
  linkId: string,
  kind: ReviewJob["kind"],
  revision: string,
) {
  if (!/^[0-9a-f]{40}$/i.test(revision)) return;
  await database
    .insert(githubReviewTable)
    .values({ linkId, kind, revision })
    .onConflictDoNothing();
}

export async function claimReview() {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(githubReviewTable)
      .where(
        and(
          isNull(githubReviewTable.completedAt),
          lte(githubReviewTable.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(githubReviewTable.nextAttemptAt), asc(githubReviewTable.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;

    // Give HTTP requests time to finish while permitting recovery after a crash.
    const [claimed] = await tx
      .update(githubReviewTable)
      .set({
        attempts: job.attempts + 1,
        nextAttemptAt: sql`(now() AT TIME ZONE 'utc') + interval '5 minutes'`,
      })
      .where(eq(githubReviewTable.id, job.id))
      .returning();
    return claimed ?? null;
  });
}

export function currentClaim(job: ReviewJob) {
  return and(
    eq(githubReviewTable.id, job.id),
    eq(githubReviewTable.attempts, job.attempts),
    isNull(githubReviewTable.completedAt),
  );
}
