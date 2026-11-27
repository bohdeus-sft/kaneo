import { MessageSquareIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CommentLinkRow } from "@/components/project/code-hosting/comment-link-row";
import { RepositoryLink } from "@/components/project/code-hosting/repository-link";
import { GithubAppStatus } from "@/components/project/github-integration/github-app-status";
import { GithubReconnectAction } from "@/components/project/github-integration/github-reconnect-action";
import { DeliveryActiveRow } from "@/components/project/integrations/delivery-panel/delivery-active-row";
import { IntegrationCheckLine } from "@/components/project/integrations/panel/integration-check-line";
import { IntegrationPanelSection } from "@/components/project/integrations/panel/integration-panel-section";
import type { GitHubAppInfo } from "@/fetchers/github-integration/get-app-info";
import type { GithubIntegration } from "@/fetchers/github-integration/get-github-integration";
import type { VerifyGithubInstallationResponse } from "@/fetchers/github-integration/verify-github-installation";
import { useUpdateGithubIntegration } from "@/hooks/mutations/github-integration/use-update-github-integration";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { toast } from "@/lib/toast";

type GithubRepositorySectionProps = {
  projectId: string;
  integration: GithubIntegration;
  appInfo: GitHubAppInfo | undefined;
  verification: VerifyGithubInstallationResponse | undefined;
  reconnecting: boolean;
  onReconnect: () => void;
};

export function GithubRepositorySection({
  projectId,
  integration,
  appInfo,
  verification,
  reconnecting,
  onReconnect,
}: GithubRepositorySectionProps) {
  const { t } = useTranslation();
  const { canManageSettings } = useWorkspacePermission();
  const { mutateAsync: update, isPending } = useUpdateGithubIntegration();
  const isConnected = Boolean(integration.isActive);
  const name = `${integration.repositoryOwner}/${integration.repositoryName}`;

  const toggleComment = async (checked: boolean) => {
    try {
      await update({
        projectId,
        json: { commentTaskLinkOnGitHubIssue: checked },
      });
      toast.success(
        checked
          ? t("settings:githubIntegration.toast.commentOnEnabled")
          : t("settings:githubIntegration.toast.commentOnDisabled"),
        { icon: MessageSquareIcon },
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:githubIntegration.toast.settingsUpdateError"),
      );
    }
  };

  const toggleIssueCreation = async (checked: boolean) => {
    try {
      await update({ projectId, json: { createIssueOnInProgress: checked } });
      toast.success(t("settings:githubIntegration.toast.updated"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:githubIntegration.toast.settingsUpdateError"),
      );
    }
  };

  return (
    <IntegrationPanelSection
      label={t("settings:codeHosting.repositorySection")}
    >
      <div className="min-w-0 space-y-1">
        <RepositoryLink name={name} href={`https://github.com/${name}`} />
        {isConnected ? <GithubAppStatus result={verification} /> : null}
      </div>
      {isConnected ? null : (
        <IntegrationCheckLine
          tone="warning"
          action={
            <GithubReconnectAction
              appInfo={appInfo}
              reconnecting={reconnecting}
              onReconnect={onReconnect}
            />
          }
        >
          {t("settings:githubIntegration.reverifyHint")}
          {appInfo && !appInfo.accountConnected
            ? ` ${
                appInfo.accountLinkingAvailable
                  ? t("settings:githubIntegration.accountVerificationHint")
                  : t("settings:githubIntegration.enableGithubSignInHint")
              }`
            : null}
        </IntegrationCheckLine>
      )}
      {isConnected ? (
        <CommentLinkRow
          title={t("settings:githubIntegration.commentTaskLinkTitle")}
          description={t("settings:githubIntegration.commentTaskLinkHint")}
          checked={integration.commentTaskLinkOnGitHubIssue !== false}
          disabled={isPending}
          onCheckedChange={toggleComment}
        />
      ) : null}
      {isConnected && (
        <DeliveryActiveRow
          title={t("settings:githubIntegration.createIssueOnInProgressTitle")}
          description={t(
            "settings:githubIntegration.createIssueOnInProgressHint",
          )}
          checked={integration.createIssueOnInProgress === true}
          disabled={isPending || !canManageSettings()}
          onCheckedChange={toggleIssueCreation}
        />
      )}
    </IntegrationPanelSection>
  );
}
