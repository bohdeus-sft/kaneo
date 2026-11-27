import {
  matchQuery,
  type QueryFilters,
  type QueryKey,
  useIsFetching,
  useQueryClient,
} from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

export function RefreshDataButton({ queryKeys }: { queryKeys: QueryKey[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filters: QueryFilters = {
    type: "active",
    predicate: (query) =>
      queryKeys.some((queryKey) => matchQuery({ queryKey }, query)),
  };
  const isFetching = useIsFetching(filters) > 0;
  const label = t("common:actions.refreshData");

  async function refresh() {
    try {
      await queryClient.refetchQueries(filters, {
        cancelRefetch: false,
        throwOnError: true,
      });
    } catch {
      toast.error(t("common:actions.refreshDataError"));
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-busy={isFetching}
            aria-disabled={isFetching}
            onClick={() => {
              if (!isFetching) void refresh();
            }}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <RefreshCwIcon
          aria-hidden="true"
          className={cn(
            "size-[15px]",
            isFetching && "motion-safe:animate-spin",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
