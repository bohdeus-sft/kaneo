import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import ruRU from "../../../../../i18n/ru-RU.json";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskTable,
  workspaceTable,
} from "../../database/schema";
import { safeOutboundError } from "../../utils/outbound-request";
import type {
  PluginContext,
  TaskCommentCreatedEvent,
  TaskCreatedEvent,
  TaskDescriptionChangedEvent,
  TaskPriorityChangedEvent,
  TaskStatusChangedEvent,
  TaskTitleChangedEvent,
} from "../types";
import { postToTelegram } from "./client";
import type { TelegramConfig, TelegramEventKey } from "./config";
import { normalizeTelegramConfig, validateTelegramConfig } from "./config";

type TelegramEventData = {
  taskTitle: string;
  projectName: string;
  taskUrl: string | null;
  status: string;
};

function isEnabled(config: TelegramConfig, key: TelegramEventKey): boolean {
  return config.events?.[key] ?? false;
}

const statusLabels: Readonly<Partial<Record<string, string>>> = {
  ...ruRU.tasks.status,
  "ready-to-merge": "Готово к слиянию",
};
const priorityLabels: Readonly<Partial<Record<string, string>>> =
  ruRU.tasks.priority;

function formatStatus(status: string): string {
  if (Object.hasOwn(statusLabels, status))
    return statusLabels[status] ?? status;
  return status.replace(/[-_]+/g, " ");
}

function formatPriority(priority: string): string {
  if (Object.hasOwn(priorityLabels, priority))
    return priorityLabels[priority] ?? priority;
  return priority;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getSafeTelegramTargetIdentifier(config: TelegramConfig): string {
  const hash = createHash("sha256")
    .update(`${config.chatId}:${config.threadId ?? "none"}`)
    .digest("hex")
    .slice(0, 12);

  return `tg:${hash}`;
}

function getTaskUrl(
  clientUrl: string | undefined,
  workspaceId: string,
  projectId: string,
  taskId: string,
): string | null {
  const normalizedClientUrl = clientUrl?.trim();
  if (!normalizedClientUrl) {
    return null;
  }

  try {
    return new URL(
      `/dashboard/workspace/${workspaceId}/project/${projectId}/task/${taskId}`,
      normalizedClientUrl,
    ).toString();
  } catch {
    return null;
  }
}

async function getTelegramEventData(
  taskId: string,
  projectId: string,
): Promise<TelegramEventData | null> {
  const [taskRow] = await db
    .select({
      title: taskTable.title,
      status: taskTable.status,
      projectName: projectTable.name,
      projectId: projectTable.id,
      workspaceId: workspaceTable.id,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .where(and(eq(taskTable.id, taskId), eq(projectTable.id, projectId)))
    .limit(1);

  if (!taskRow) {
    return null;
  }

  return {
    taskTitle: taskRow.title,
    projectName: taskRow.projectName,
    taskUrl: getTaskUrl(
      process.env.KANEO_CLIENT_URL,
      taskRow.workspaceId,
      taskRow.projectId,
      taskId,
    ),
    status: taskRow.status,
  };
}

async function sendTelegramMessage(
  config: TelegramConfig,
  message: TelegramMessageContent,
  data: TelegramEventData,
): Promise<void> {
  const escapedTaskLabel = escapeHtml(data.taskTitle);
  const taskLine = data.taskUrl
    ? `<a href="${escapeHtml(data.taskUrl)}">${escapedTaskLabel}</a>`
    : escapedTaskLabel;

  const lines = [
    `<b>${escapeHtml(message.title)}</b>`,
    ...(message.body ? [escapeHtml(message.body)] : []),
    "",
    `<b>Задача:</b> ${taskLine}`,
    `<b>Проект:</b> ${escapeHtml(data.projectName)}`,
    `<b>Статус:</b> ${escapeHtml(formatStatus(message.status ?? data.status))}`,
  ];

  try {
    await postToTelegram(config.botToken, {
      chat_id: config.chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: false,
      message_thread_id: config.threadId,
    });
  } catch (error) {
    console.error("sendTelegramMessage postToTelegram failed", {
      error: safeOutboundError(error),
      telegramTarget: getSafeTelegramTargetIdentifier(config),
      taskUrl: data.taskUrl,
    });
  }
}

type TelegramMessageContent = {
  title: string;
  body?: string;
  status?: string;
};

async function runTelegramHandler(
  context: PluginContext,
  event: {
    taskId: string;
    projectId: string;
  },
  featureKeys: TelegramEventKey[],
  buildMessage: (
    config: TelegramConfig,
  ) => TelegramMessageContent | null | Promise<TelegramMessageContent | null>,
): Promise<void> {
  const validation = validateTelegramConfig(context.config);
  if (!validation.valid) {
    console.error("Invalid Telegram plugin config; skipping event dispatch", {
      reason: "Invalid configuration",
      featureKeys,
      projectId: event.projectId,
      taskId: event.taskId,
    });
    return;
  }

  const config = normalizeTelegramConfig(context.config as TelegramConfig);
  if (!featureKeys.some((key) => isEnabled(config, key))) return;

  const message = await buildMessage(config);
  if (!message) return;
  const data = await getTelegramEventData(event.taskId, event.projectId);
  if (!data) return;

  await sendTelegramMessage(config, message, data);
}

export async function handleTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<void> {
  await runTelegramHandler(context, event, ["taskCreated"], () => ({
    title: "Создана новая задача",
  }));
}

export async function handleTaskStatusChanged(
  event: TaskStatusChangedEvent,
  context: PluginContext,
): Promise<void> {
  await runTelegramHandler(
    context,
    event,
    ["taskStatusChanged", "taskCompleted"],
    async (config) => {
      if (isEnabled(config, "taskCompleted")) {
        const finalColumns = await db
          .select({ slug: columnTable.slug })
          .from(columnTable)
          .where(
            and(
              eq(columnTable.projectId, event.projectId),
              eq(columnTable.isFinal, true),
              inArray(columnTable.slug, [event.oldStatus, event.newStatus]),
            ),
          );
        const completed =
          finalColumns.some(({ slug }) => slug === event.newStatus) &&
          !finalColumns.some(({ slug }) => slug === event.oldStatus);
        if (completed) {
          return {
            title: "Задача завершена",
            status: event.newStatus,
          };
        }
      }
      if (!isEnabled(config, "taskStatusChanged")) return null;
      return {
        title: "Статус задачи изменён",
        body: `${formatStatus(event.oldStatus)} → ${formatStatus(event.newStatus)}`,
        status: event.newStatus,
      };
    },
  );
}

export async function handleTaskPriorityChanged(
  event: TaskPriorityChangedEvent,
  context: PluginContext,
): Promise<void> {
  await runTelegramHandler(context, event, ["taskPriorityChanged"], () => ({
    title: "Приоритет задачи изменён",
    body: `${formatPriority(event.oldPriority)} → ${formatPriority(event.newPriority)}`,
  }));
}

export async function handleTaskTitleChanged(
  event: TaskTitleChangedEvent,
  context: PluginContext,
): Promise<void> {
  await runTelegramHandler(context, event, ["taskTitleChanged"], () => ({
    title: "Название задачи изменено",
    body: `${truncate(event.oldTitle, 120)} → ${truncate(event.newTitle, 120)}`,
  }));
}

export async function handleTaskDescriptionChanged(
  event: TaskDescriptionChangedEvent,
  context: PluginContext,
): Promise<void> {
  await runTelegramHandler(context, event, ["taskDescriptionChanged"], () => ({
    title: "Описание задачи изменено",
    body: truncate(
      event.newDescription?.replace(/\s+/g, " ").trim() ?? "",
      160,
    ),
  }));
}

export async function handleTaskCommentCreated(
  event: TaskCommentCreatedEvent,
  context: PluginContext,
): Promise<void> {
  await runTelegramHandler(context, event, ["taskCommentCreated"], () => ({
    title: "Новый комментарий к задаче",
    body: truncate(event.comment.replace(/\s+/g, " "), 200),
  }));
}
