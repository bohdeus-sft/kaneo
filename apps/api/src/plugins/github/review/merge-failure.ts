export const mergeFailureMarker = "<!-- kaneo-merge-failure -->";

export function readMergeFailure(comment: {
  body: string;
  user: { id?: number; login: string } | null;
}) {
  if (
    comment.user?.id !== 41898282 ||
    comment.user.login !== "github-actions[bot]"
  )
    return null;
  if (!comment.body.startsWith(mergeFailureMarker + "\n")) return null;
  const report = comment.body.slice(mergeFailureMarker.length).trim();
  return report && report.length <= 4_000 ? report : null;
}
