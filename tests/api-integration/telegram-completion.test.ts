import { expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  broadcastTaskCreated,
  broadcastTaskStatusChanged,
  registerPlugin,
} from "../../apps/api/src/plugins/registry";
import { telegramPlugin } from "../../apps/api/src/plugins/telegram";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const { send } = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../apps/api/src/plugins/telegram/client", () => ({
  postToTelegram: send,
}));

it("delivers creation and transitions into a final column through the Telegram event settings", async () => {
  await resetTestDatabase();
  registerPlugin(telegramPlugin);
  const { user, workspace } = await createWorkspaceMember({ role: "admin" });
  const { project } = await createProjectFixture({ workspaceId: workspace.id });
  await db.insert(schema.columnTable).values({
    projectId: project.id,
    slug: "released",
    name: "Released",
    position: 10,
    isFinal: true,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Test & <6>", number: 12 })
    .returning();
  mockAuthenticatedSession(user);
  const { app } = createApp();
  const path = `/api/telegram-integration/project/${project.id}`;
  const request = (method: "POST" | "PATCH", body: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const initial = await request("POST", {
    botToken: `123456789:${"x".repeat(35)}`,
    chatId: "-1001234567890",
  });
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({
    events: { taskCompleted: false },
  });

  const settings = await request("PATCH", {
    events: {
      taskCreated: true,
      taskCompleted: true,
      taskStatusChanged: false,
      taskCommentCreated: false,
    },
  });
  expect(settings.status).toBe(200);
  expect(await (await app.request(path)).json()).toMatchObject({
    events: {
      taskCreated: true,
      taskCompleted: true,
      taskStatusChanged: false,
    },
  });

  const event = {
    taskId: task.id,
    projectId: project.id,
    userId: user.id,
    title: task.title,
  };
  const move = (oldStatus: string, newStatus: string) =>
    broadcastTaskStatusChanged({ ...event, oldStatus, newStatus });
  await broadcastTaskCreated({
    ...event,
    description: null,
    number: 12,
    priority: task.priority,
    status: task.status,
  });
  await move("to-do", "in-progress");
  await move("in-progress", "released");
  await move("released", "done");
  await move("done", "to-do");
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]?.[1]?.text).toBe(
    [
      "<b>Создана новая задача</b>",
      "",
      `<b>Задача:</b> <a href="${process.env.KANEO_CLIENT_URL}/dashboard/workspace/${workspace.id}/project/${project.id}/task/${task.id}">Test &amp; &lt;6&gt;</a>`,
      `<b>Проект:</b> ${project.name}`,
      "<b>Статус:</b> К выполнению",
    ].join("\n"),
  );
  expect(send.mock.calls[1]?.[1]?.text).toContain("<b>Задача завершена</b>");

  const both = await request("PATCH", { events: { taskStatusChanged: true } });
  expect(both.status).toBe(200);
  await move("to-do", "done");
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]?.[1]?.text).toContain("<b>Задача завершена</b>");
  expect(send.mock.calls[2]?.[1]?.text).toContain("<b>Статус:</b> Готово");
  await move("in-progress", "in-review");
  expect(send.mock.calls[3]?.[1]?.text).toContain("В работе → На проверке");
});
