import { activityTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import type { IntegrationDatabase } from "../services/integration-task-scope";

export async function saveReviewReport(
  database: IntegrationDatabase,
  afterCommit: (effect: () => Promise<void>) => void,
  report: {
    taskId: string;
    projectId: string;
    source: string;
    url: string;
    content: string;
  },
) {
  const [activity] = await database
    .insert(activityTable)
    .values({
      taskId: report.taskId,
      type: "comment",
      content: report.content,
      externalSource: report.source,
      externalUserName: "Kaneo AI Review",
      externalUrl: report.url,
    })
    .onConflictDoUpdate({
      target: [
        activityTable.taskId,
        activityTable.externalSource,
        activityTable.externalUrl,
      ],
      set: { content: report.content, updatedAt: new Date() },
    })
    .returning({ id: activityTable.id });

  if (activity) {
    // Realtime for the activity list without triggering outbound comment sync.
    afterCommit(() =>
      publishEvent("comment.updated", {
        id: activity.id,
        taskId: report.taskId,
        projectId: report.projectId,
      }),
    );
  }
}
