import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { IntegrationPanelSection } from "@/components/project/integrations/panel/integration-panel-section";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useUpdateGithubIntegration } from "@/hooks/mutations/github-integration/use-update-github-integration";
import { toast } from "@/lib/toast";

type GithubAiReviewSectionProps = {
  projectId: string;
  savedModel: string | null;
  canManage: boolean;
};

export function GithubAiReviewSection({
  projectId,
  savedModel,
  canManage,
}: GithubAiReviewSectionProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const descriptionId = useId();
  const [enabled, setEnabled] = useState(savedModel !== null);
  const [model, setModel] = useState(savedModel ?? "");
  const { mutateAsync: updateIntegration, isPending } =
    useUpdateGithubIntegration();
  const nextModel = enabled ? model.trim() : null;
  const canSave =
    canManage &&
    (nextModel === null || nextModel.length > 0) &&
    nextModel !== savedModel;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || isPending) return;
    try {
      await updateIntegration({
        projectId,
        json: { aiReviewModel: nextModel },
      });
      toast.success(t("settings:githubIntegration.toast.updated"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:githubIntegration.toast.updateError"),
      );
    }
  }

  return (
    <IntegrationPanelSection
      label={
        <span id={labelId}>
          {t("settings:githubIntegration.aiReview.title")}
        </span>
      }
      description={
        <span id={descriptionId}>
          {t("settings:githubIntegration.aiReview.description")}
        </span>
      }
      action={
        <Switch
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          checked={enabled}
          disabled={!canManage || isPending}
          onCheckedChange={setEnabled}
        />
      }
    >
      {(enabled || nextModel !== savedModel) && (
        <form className="space-y-3" onSubmit={save}>
          {enabled && (
            <Field disabled={!canManage || isPending}>
              <FieldLabel>
                {t("settings:githubIntegration.aiReview.model")}
              </FieldLabel>
              <Input
                type="text"
                value={model}
                maxLength={200}
                required
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setModel(event.target.value)}
              />
            </Field>
          )}
          {canManage && (
            <Button type="submit" size="sm" disabled={!canSave || isPending}>
              {isPending
                ? t("settings:githubIntegration.aiReview.saving")
                : t("settings:githubIntegration.aiReview.save")}
            </Button>
          )}
        </form>
      )}
    </IntegrationPanelSection>
  );
}
