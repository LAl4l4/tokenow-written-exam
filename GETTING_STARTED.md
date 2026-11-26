# 本地开发指南

## 启动

安装 Node.js 24.12 或更高版本（含 npm）。在终端执行以下命令。

```sh
git clone https://github.com/TokeNow/todo-agent.git
cd todo-agent
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>。前后端共用这个地址，修改服务端代码后服务会自动重启。修改聊天界面的 TSX 后，在另一个终端运行 `npm run build` 并刷新页面。若 3000 端口已占用，可以用 `PORT=3001 npm run dev` 指定其他端口（macOS / Linux）。

## 接入 DeepSeek

1. 在项目根目录将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中填写 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key。可通过 `DEEPSEEK_MODEL` 更换模型。
3. 重启开发服务。在服务端使用 [server/model.ts](server/model.ts) 导出的 `getModelClient()` 获取客户端，使用 `model` 读取配置的模型名称。只有发起模型请求才会产生调用费用。

## 代码入口

| 文件                                         | 用途                                       |
| -------------------------------------------- | ------------------------------------------ |
| [src/App.tsx](src/App.tsx)                   | 聊天界面，发送当前页面的对话历史并显示回复 |
| [server/index.ts](server/index.ts)           | 接入智能体与任务存储，启动服务             |
| [server/agent.ts](server/agent.ts)           | 候选人实现入口，接收消息数组，返回回复文本 |
| [server/model.ts](server/model.ts)           | 服务端 DeepSeek 客户端与模型配置           |
| [server/tasks.ts](server/tasks.ts)           | 任务 API 的输入校验和 HTTP 响应            |
| [server/app.ts](server/app.ts)               | 接收对话历史，调用智能体并挂载任务 API     |
| [server/task-store.ts](server/task-store.ts) | 读写本地 JSON 任务清单                     |
| [server/openapi.yaml](server/openapi.yaml)   | 任务请求和响应的完整定义                   |

## 手动验证接口

启动服务后，在另一个终端发送聊天消息。

```sh
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

聊天需要配置 DeepSeek 密钥。后续请求可在 `messages` 中按顺序传入之前的用户消息和小明的回复，再追加最新的用户消息。可以用以下消息验证扩展功能。

- 「帮我记一下交报告，明天下午三点截止，优先级 P0，工作量大。」
- 「给交报告加一个子任务，叫整理数据。」
- 「完成整理数据。」
- 「看看明天有哪些任务到期，包括已完成的。」

到期查询按服务端本地时区计算，包含指定范围的起点和终点。当天没有指定具体截止时刻的任务按当天 23:59 比较。到期查询默认显示未完成的任务。查询范围包含今天时，回复末尾会另外列出更早已过期且未完成的任务。

子任务支持一层，创建后固定归属于原父任务，普通清单会将它们缩进显示在父任务下。同级任务按 P0 到 P3 排列，缺省为 P2，同优先级按创建顺序排列。聊天中的普通清单先用一行摘要给出待办和已过期的数量，再把顶层任务分为「已过期」「待办」「已完成」三组；只要父任务或它的任一未完成子任务已过期，整组就归入「已过期」。待办行显示优先级、相对截止时间（如「明天到期」「已过期 2 天」）、工作量和子任务进度，已完成行只显示名称。`GET /api/tasks` 的顺序不受影响。所有子任务完成时，父任务会自动完成。新增或重新打开子任务会将父任务恢复为待办。完成、重新打开或删除父任务会同步处理它的全部子任务。

创建一条任务，然后检查列表。

```sh
curl -sS http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"买牛奶"}'
curl -sS http://127.0.0.1:3000/api/tasks
```

首次创建任务时，服务会在项目根目录创建 `data/tasks.json`。这些任务会保留到下次启动，浏览器中的聊天记录则会在刷新后清空。

## 本地检查

```sh
npm test
npm run typecheck
npm run lint
npm run fmt:check
npm run build
```

测试使用独立的临时目录。要预览构建产物，先停止开发服务，再运行 `npm start` 并打开同一地址。
