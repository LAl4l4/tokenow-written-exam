import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createTaskReply } from "./agent.ts";
import { createApp } from "./app.ts";
import { planWithModel } from "./model.ts";
import { createJsonTaskStore } from "./task-store.ts";

// 2026-11-26（周四）10:30，服务端本地时间。
const fixedNow = () => new Date(2026, 10, 26, 10, 30);

async function startTestApp(t: TestContext, planTurn?: Parameters<typeof createTaskReply>[1]) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const tasks = createJsonTaskStore(filename);
  const app = createApp({
    tasks,
    reply: planTurn
      ? createTaskReply(tasks, planTurn, fixedNow)
      : async (messages) => {
          conversations.push(messages);
          return "收到";
        },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("子任务只支持一层且归属固定，删除父任务会同时移除其子任务", async (t) => {
  const { request, filename } = await startTestApp(t);
  const collection = "/api/tasks";
  const { body: parent } = await request("POST", collection, { title: "写报告" });
  const { body: child } = await request("POST", collection, {
    title: "查数据",
    parentId: parent.id,
  });
  const { body: other } = await request("POST", collection, { title: "取快递" });
  assert.equal(child.parentId, parent.id);
  assert.equal(
    (await request("POST", collection, { title: "孤立子任务", parentId: "missing" })).status,
    409,
  );
  assert.equal(
    (await request("POST", collection, { title: "第二层", parentId: child.id })).status,
    409,
  );
  assert.equal(
    (await request("PATCH", `${collection}/${child.id}`, { parentId: null })).status,
    400,
  );
  assert.equal(
    (await request("PATCH", `${collection}/${child.id}`, { parentId: other.id })).status,
    400,
  );
  assert.equal((await request("DELETE", `${collection}/${parent.id}`)).status, 204);
  assert.deepEqual(createJsonTaskStore(filename).list(), [other]);
});

test("聊天按父子分组排序，完成和重新打开父子任务会联动持久化", async (t) => {
  let plan: unknown;
  const { request, filename } = await startTestApp(t, async () => plan);
  const collection = "/api/tasks";
  async function send(content: string, nextPlan: unknown) {
    plan = nextPlan;
    const response = await request("POST", "/api/chat", { messages: [{ role: "user", content }] });
    assert.equal(response.status, 200);
    return response.body.reply as string;
  }
  const { body: parent } = await request("POST", collection, { title: "交报告" });
  await request("POST", collection, { title: "订机票", priority: 1 });
  await request("POST", collection, { title: "读邮件" });
  const { body: review } = await request("POST", collection, {
    title: "检查格式",
    parentId: parent.id,
    priority: 3,
  });
  const { body: collect } = await request("POST", collection, {
    title: "整理数据",
    parentId: parent.id,
    priority: 0,
  });
  const list = await send("查看所有任务", { action: "list" });
  assert.equal(
    list,
    [
      "共 3 项待办。",
      "",
      "📌 待办",
      "  ○ P1 订机票",
      "  ○ P2 交报告 · 子任务 0/2",
      "      ○ P0 整理数据",
      "      ○ P3 检查格式",
      "  ○ P2 读邮件",
    ].join("\n"),
  );

  async function setDone(id: string, title: string, done: boolean) {
    return send(`${done ? "完成" : "重新打开"}${title}`, {
      action: "update",
      id,
      changes: { done },
    });
  }
  function reportStatus() {
    return Object.fromEntries(
      createJsonTaskStore(filename)
        .list()
        .filter((task) => task.id === parent.id || task.parentId === parent.id)
        .map(({ title, done }) => [title, done]),
    );
  }

  await setDone(collect.id, collect.title, true);
  assert.deepEqual(reportStatus(), { 交报告: false, 检查格式: false, 整理数据: true });
  assert.match(await setDone(review.id, review.title, true), /父任务.*交报告.*也已完成/);
  assert.deepEqual(reportStatus(), { 交报告: true, 检查格式: true, 整理数据: true });
  assert.match(await setDone(review.id, review.title, false), /父任务.*交报告.*已恢复为待办/);
  assert.deepEqual(reportStatus(), { 交报告: false, 检查格式: false, 整理数据: true });
  await setDone(parent.id, parent.title, true);
  assert.deepEqual(reportStatus(), { 交报告: true, 检查格式: true, 整理数据: true });
  const added = await send("给交报告加一个子任务，叫准备附件", {
    action: "create",
    task: { title: "准备附件", parentId: parent.id },
  });
  assert.match(added, /父任务.*交报告.*已恢复为待办/);
  assert.deepEqual(reportStatus(), {
    交报告: false,
    检查格式: true,
    整理数据: true,
    准备附件: false,
  });
  await setDone(parent.id, parent.title, false);
  assert.deepEqual(reportStatus(), {
    交报告: false,
    检查格式: false,
    整理数据: false,
    准备附件: false,
  });
  const deleted = await send("删除交报告", { action: "delete", id: parent.id });
  assert.match(deleted, /已删除.*交报告.*3 个子任务/);
  assert.deepEqual(reportStatus(), {});
});

test("普通清单按已过期、待办、已完成分组，显示相对截止时间和子任务进度", async (t) => {
  let plan: unknown = { action: "list" };
  const { request } = await startTestApp(t, async () => plan);
  async function list(status?: string) {
    plan = status ? { action: "list", status } : { action: "list" };
    const response = await request("POST", "/api/chat", {
      messages: [{ role: "user", content: "看看清单" }],
    });
    assert.equal(response.status, 200);
    return response.body.reply as string;
  }
  async function create(body: unknown) {
    const response = await request("POST", "/api/tasks", body);
    assert.equal(response.status, 201);
    return response.body;
  }

  assert.match(await list(), /清单是空的/);
  const milk = await create({ title: "买牛奶" });
  await request("PATCH", `/api/tasks/${milk.id}`, { done: true });
  const report = await create({
    title: "交报告",
    dueAt: "2026-11-25",
    priority: 0,
    effort: "large",
  });
  const data = await create({ title: "整理数据", parentId: report.id });
  await request("PATCH", `/api/tasks/${data.id}`, { done: true });
  await create({ title: "写结论", parentId: report.id, dueAt: "2026-11-26T18:00" });
  await create({ title: "取快递", dueAt: "2026-11-27" });
  await create({ title: "订机票", dueAt: "2026-11-29", priority: 1 });
  await create({ title: "交房租", dueAt: "2026-12-01T09:30" });
  await create({ title: "续签护照", dueAt: "2026-12-20" });
  await create({ title: "体检", dueAt: "2027-01-10", priority: 3 });
  await create({ title: "读书" });

  assert.equal(
    await list(),
    [
      "共 7 项待办，其中 1 项已过期；已完成 1 项。",
      "",
      "⚠️ 已过期",
      "  ○ P0 交报告 · 已过期 1 天 · 工作量大 · 子任务 1/2",
      "      ✓ 整理数据",
      "      ○ P2 写结论 · 今天 18:00 到期",
      "",
      "📌 待办",
      "  ○ P1 订机票 · 周日到期",
      "  ○ P2 取快递 · 明天到期",
      "  ○ P2 交房租 · 下周二 09:30 到期",
      "  ○ P2 续签护照 · 12月20日到期",
      "  ○ P2 读书",
      "  ○ P3 体检 · 2027-01-10 到期",
      "",
      "✅ 已完成",
      "  ✓ 买牛奶",
    ].join("\n"),
  );

  const open = await list("open");
  assert.match(open, /^共 7 项待办，其中 1 项已过期。\n/);
  assert.doesNotMatch(open, /已完成|买牛奶|整理数据/);
  assert.match(open, /交报告 · 已过期 1 天 · 工作量大 · 子任务 1\/2\n {6}○ P2 写结论/);

  assert.equal(await list("done"), "已完成 2 项。\n\n  ✓ 交报告 / 整理数据\n  ✓ 买牛奶");

  plan = { action: "list", parentId: report.id };
  const children = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "交报告还剩哪些子任务" }],
  });
  assert.equal(
    children.body.reply,
    "「交报告」的子任务（已完成 1/2）\n\n  ○ P2 写结论 · 今天 18:00 到期\n  ✓ 整理数据",
  );
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("通过聊天创建、查看、完成和删除任务，并持久化到同一份清单", async (t) => {
  let plan: unknown;
  const { request, filename } = await startTestApp(t, async () => plan);
  const messages: ChatMessage[] = [];
  async function send(content: string, nextPlan: unknown) {
    plan = nextPlan;
    messages.push({ role: "user", content });
    const response = await request("POST", "/api/chat", { messages });
    assert.equal(response.status, 200);
    messages.push({ role: "assistant", content: response.body.reply });
    return response.body.reply as string;
  }

  assert.match(
    await send("帮我记一下买牛奶", { action: "create", task: { title: "买牛奶" } }),
    /已添加.*买牛奶/,
  );
  await send("再记一条取快递", { action: "create", task: { title: "取快递" } });
  const initial = await send("我有哪些任务？", { action: "list" });
  assert.match(initial, /^共 2 项待办。/);
  assert.match(initial, /○ P2 买牛奶\n  ○ P2 取快递/);

  const [milk, parcel] = createJsonTaskStore(filename).list();
  assert.match(
    await send("牛奶买好了", { action: "update", id: milk.id, changes: { done: true } }),
    /已完成.*买牛奶/,
  );
  assert.match(
    await send("取快递这条删掉吧", { action: "delete", id: parcel.id }),
    /已删除.*取快递/,
  );
  const remaining = await send("再给我看看清单", { action: "list" });
  assert.equal(remaining, "1 项任务都已完成，没有待办。\n\n✅ 已完成\n  ✓ 买牛奶");
  assert.doesNotMatch(remaining, /取快递/);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...milk, done: true }]);
});

test("到期查询支持日期与分钟边界，并按优先级展示", async (t) => {
  let plan: unknown;
  const { request } = await startTestApp(t, async () => plan);
  const collection = "/api/tasks";
  async function create(body: unknown) {
    const response = await request("POST", collection, body);
    assert.equal(response.status, 201);
    return response.body;
  }
  await create({ title: "全天任务", dueAt: "2026-11-26" });
  await create({ title: "早班", dueAt: "2026-11-26T09:00", priority: 1, effort: "medium" });
  await create({ title: "交报告", dueAt: "2026-11-26T11:00", priority: 0, effort: "large" });
  await create({ title: "明天交付", dueAt: "2026-11-27T00:00", priority: 0 });
  await create({ title: "无截止日期" });
  await create({ title: "昨天的事", dueAt: "2026-11-25", priority: 1 });
  const done = await create({ title: "已办事项", dueAt: "2026-11-26T10:00" });
  await request("PATCH", `${collection}/${done.id}`, { done: true });

  async function query(content: string, queryPlan: unknown) {
    plan = queryPlan;
    const response = await request("POST", "/api/chat", { messages: [{ role: "user", content }] });
    assert.equal(response.status, 200);
    return response.body.reply as string;
  }
  const today = await query("今天有哪些任务到期？", {
    action: "list",
    due: { from: "2026-11-26", to: "2026-11-26" },
  });
  assert.equal(
    today,
    [
      "到期清单（2026-11-26 至 2026-11-26），共 3 项",
      "",
      "  ○ P0 交报告 · 今天 11:00 到期 · 工作量大",
      "  ○ P1 早班 · 已过期（今天 09:00） · 工作量中",
      "  ○ P2 全天任务 · 今天到期",
      "",
      "⚠️ 另有 1 项已过期未完成",
      "  ○ P1 昨天的事 · 已过期 1 天",
    ].join("\n"),
  );

  const tomorrow = await query("明天有哪些任务到期？", {
    action: "list",
    due: { from: "2026-11-27", to: "2026-11-27" },
  });
  assert.equal(
    tomorrow,
    "到期清单（2026-11-27 至 2026-11-27），共 1 项\n\n  ○ P0 明天交付 · 明天 00:00 到期",
  );

  const morning = await query("看看上午九点到十一点到期的全部任务", {
    action: "list",
    status: "all",
    due: { from: "2026-11-26T09:00", to: "2026-11-26T11:00" },
  });
  assert.match(morning, /交报告[\s\S]*早班[\s\S]*✓ 已办事项[\s\S]*已过期未完成\n.*昨天的事/);
  assert.doesNotMatch(morning, /全天任务/);
  assert.equal(
    (await request("POST", collection, { title: "错误日期", dueAt: "2026-02-29" })).status,
    400,
  );
  assert.equal(
    (await request("POST", collection, { title: "错误优先级", priority: 4 })).status,
    400,
  );
});

test("智能体只执行通过校验且基于当前清单的操作", async (t) => {
  const { request, filename } = await startTestApp(t, async (system, messages) => {
    if (messages.at(-1)?.content === "改错字段") {
      return { action: "create", task: { title: "不应写入", effort: "huge" } };
    }
    const tasks = createJsonTaskStore(filename);
    const [target] = tasks.list();
    assert.match(system, /任务清单 JSON：.*买牛奶/);
    tasks.update(target.id, { title: "换成买面包" });
    return { action: "delete", id: target.id };
  });

  await request("POST", "/api/tasks", { title: "买牛奶" });
  const invalid = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "改错字段" }],
  });
  assert.match(invalid.body.reply, /没能识别/);
  const stale = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "删除买牛奶" }],
  });
  assert.match(stale.body.reply, /清单刚刚有变动/);
  assert.deepEqual(
    createJsonTaskStore(filename)
      .list()
      .map(({ title }) => title),
    ["换成买面包"],
  );
});

test("DeepSeek 客户端以 JSON 模式发送对话并执行返回的操作", async (t) => {
  const key = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  t.after(() => {
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = key;
  });

  const fetchOriginal = globalThis.fetch;
  const mockFetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = new Request(input, init);
      if (outgoing.url !== "https://api.deepseek.com/chat/completions")
        return fetchOriginal(outgoing);
      const payload = await outgoing.json();
      assert.deepEqual(payload.response_format, { type: "json_object" });
      assert.deepEqual(payload.thinking, { type: "disabled" });
      assert.deepEqual(payload.messages.at(-1), { role: "user", content: "提醒我买牛奶" });
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ action: "create", task: { title: "买牛奶" } }) },
          },
        ],
      });
    },
  );

  const { request, filename } = await startTestApp(t, planWithModel);
  const response = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "提醒我买牛奶" }],
  });
  assert.equal(response.status, 200);
  assert.match(response.body.reply, /已添加.*买牛奶/);
  assert.equal(mockFetch.mock.callCount(), 2);
  assert.equal(createJsonTaskStore(filename).list()[0].title, "买牛奶");
});
