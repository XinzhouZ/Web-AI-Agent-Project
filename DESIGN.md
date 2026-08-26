# CodeForge — 代码生成与展示 Web AI Agent 设计文档

> 版本：v0.1 ｜ 日期：2026-08-25 ｜ 状态：设计定稿，附可运行原型（`backend/` + `frontend/`）

---

## 1. 产品定位

**一句话**：用户用自然语言描述需求，Agent 生成代码并在浏览器中即时展示（语法高亮 / 实时预览 / 会话式迭代）的 Web AI 应用。

**目标用户**：开发者、技术团队、编程学习者。

**核心场景**：
1. **从零生成**："写一个带深色模式的番茄钟" → Agent 产出多文件前端代码 → 右侧面板立即渲染预览。
2. **对话式迭代**："把按钮换成圆角、加一个统计图" → Agent 更新文件 → 版本号 +1，可查看变更。
3. **代码展示**：语法高亮阅读、文件树导航、一键预览、（后续）分享只读链接。

**边界（v1 不做）**：后端工程脚手架、真实构建管线（Vite/webpack）、多人协作、在线执行任意后端代码。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ 前端  React 18 + TypeScript + Vite                          │
│  初始化向导 / 注册登录 / 工作台                               │
│  对话流(SSE 渲染) · 代码高亮(prism) · 沙箱预览(sandbox iframe)│
└──────────────┬─────────────────────────────────────────────┘
               │ REST(JSON) + SSE(text/event-stream)
┌──────────────▼─────────────────────────────────────────────┐
│ 后端  FastAPI (Python 3.11+)                                │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ system  │ │  auth   │ │ sessions │ │  agent 编排       │  │
│  │ 初始化   │ │ 注册/登录│ │ 会话/消息 │ │ 工具循环 + SSE    │  │
│  └─────────┘ └─────────┘ └──────────┘ └────────┬─────────┘  │
│                                              │              │
│  LLM 适配层（Anthropic SDK，密钥/模型来自初始化配置）          │
└──────────────┬───────────────────────────────┼──────────────┘
               │                               │
        ┌──────▼──────┐              ┌─────────▼─────────┐
        │ SQLite/     │              │ Claude API         │
        │ PostgreSQL  │              │ (messages + tools) │
        └─────────────┘              └───────────────────┘
```

**技术选型**

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React + TS + Vite | 生态成熟，SSE 流式渲染组件化清晰 |
| 代码高亮 | prism-react-renderer（原型）/ Shiki（生产） | 前者支持流式部分代码高亮，后者主题质量高 |
| 预览 | `<iframe sandbox="allow-scripts">` + srcDoc | 无 same-origin，天然隔离用户生成代码 |
| 后端 | FastAPI + uvicorn | 原生 async，SSE/流式一等公民，Pydantic 校验 |
| ORM | SQLAlchemy 2.x | 原型用 SQLite，生产切 PostgreSQL 只换连接串 |
| 认证 | JWT(access 30min + refresh 7d) + bcrypt | 无状态、易横向扩展 |
| LLM | Anthropic 官方 SDK（`anthropic` 包） | 原生流式 tool use、prompt caching、thinking |

---

## 3. 三大核心流程

### 3.1 系统初始化（首次部署，一次性）

**触发条件**：`system_config` 表无 `initialized=true` 记录。

```
前端启动 ──GET /api/system/status──► {initialized: false}
   │                                    │
   ▼                                    ▼
强制路由到 /setup              后端 Guard：未初始化时
   │                          除 system/* 外全部 403
   ▼
初始化向导（3 步）
 Step1 管理员账号：用户名 + 邮箱 + 强密码
 Step2 LLM 配置：  API Key (+可选 BaseURL) + 模型
                  └─「测试连接」→ POST /api/system/test-llm
                     （用请求体中的 Key 发 1 条最小请求，不落库）
 Step3 注册策略：  开放注册 / 关闭注册（邀请码模式留接口）
   │
   ▼ 确认提交
POST /api/system/init
   ├─ 事务内：创建 admin 用户 + 写 system_config
   ├─ API Key 用 AES-256-GCM(Fernet) 加密落库
   └─ 此后 /api/system/init 永久返回 403
```

**安全要点**：
- 初始化接口只在未初始化窗口期可用，防止二次接管；
- Key 派生自服务端 `SERVER_SECRET` 环境变量，密文落库，日志全量脱敏；
- `SERVER_SECRET` 与数据库分离存放（生产：环境变量/密钥管理服务）。

**初始化后接入更多模型服务**（Key 填错 / 多供应商等场景）：运行期以 `llm_providers`
表为准，支持同时接入 Anthropic 官方、智谱 GLM（`https://open.bigmodel.cn/api/anthropic`，
Anthropic 协议兼容，模型 `glm-5.3` / `glm-5.3[1m]` / `glm-4.7` / `glm-4.6`）及任意兼容网关。
管理员在「模型服务管理」中增删改查（api_key 留空 = 沿用），每个服务可独立开关 thinking、
max_tokens；聊天时按请求指定 `provider_id + model`，缺省用默认服务。
注意：智谱 GLM Coding Plan 套餐额度官方限定指定编程工具，自建应用可能需改用充值 Key。
配置修改不重开放 `/api/system/init`，避免二次接管风险。

### 3.2 注册 / 登录

```
注册（受 Step3 策略控制）
  POST /api/auth/register {username, email, password}
  ├─ 密码强度校验（≥8 位，含字母数字）
  ├─ bcrypt(cost=12) 哈希落库
  ├─ 用户名/邮箱唯一性校验
  └─ 成功 → 自动登录（直接签发 token）

登录
  POST /api/auth/login {username, password}
  ├─ 失败计数（内存/Redis），5 次锁定 15 分钟
  └─ 成功 → access_token(30min) + refresh_token(7d, HttpOnly Cookie 可选)

令牌刷新
  POST /api/auth/refresh {refresh_token}
  └─ 校验有效 → 签发新 access（refresh 可轮换）

角色：admin（管理 LLM 配置/用户/策略）/ user（使用工作台）
```

> 原型实现：邮箱验证码、SMTP、OAuth(GitHub)、邀请码模式在设计中预留（`allow_registration` 枚举可扩展 `invite_code`），原型只实现"开放/关闭"两档。

### 3.3 会话与代码生成（Agent 主循环）

```
用户在工作台发送需求
   │
   ▼
POST /api/sessions/{id}/chat   (SSE 响应)
   │
   ▼ 后端 Agent 循环（最多 N 轮，防失控）
┌──────────────────────────────────────────────┐
│ 1. 组装上下文                                  │
│    system = 角色 prompt + 当前工件文件清单      │
│    messages = 会话持久化上下文 + 本轮用户输入    │
│ 2. 调 Claude（流式）                           │
│    thinking: adaptive (summarized)            │
│    tools: [write_file] + prompt caching       │
│    ── SSE 推送 text_delta / thinking_delta     │
│ 3. stop_reason == "tool_use"？                 │
│    ├─ 否 → 循环结束                            │
│    └─ 是 → 执行 write_file：                   │
│         写入工件 JSON，版本 +1                  │
│         ── SSE 推送 artifact_updated           │
│         tool_result 回填 → 回到 2              │
└──────────────────────────────────────────────┘
   │
   ▼
持久化：assistant 消息 + 工具事件 + 完整 API 上下文
SSE done {messageId, usage}
```

**上下文管理**：
- 每个会话持久化**原始 API message 列表**（含 tool_use/tool_result 块），保证多轮工具调用的保真回放；
- 工件文件**全文不进历史**——只在每轮 system prompt 注入文件清单（路径+行数+语言），修改内容由 tool_result 摘要承载，避免上下文膨胀；
- prompt caching：system + tools 前缀稳定，命中缓存可降 ~90% 输入成本。

**工具定义（v1）**

| 工具 | 参数 | 行为 |
|---|---|---|
| `write_file` | `path`, `content` | 写入/覆盖工件文件，版本 +1，前端实时刷新 |

（设计预留：`update_plan` 任务清单、`read_file` 读取指定文件、`run_preview` 触发构建。）

**SSE 事件协议**

```
event: status           data: {"stage":"thinking|generating|tool"}
event: text_delta       data: {"delta":"..."}
event: thinking_delta   data: {"delta":"..."}
event: tool_call        data: {"id":"...","name":"write_file","input":{...}}
event: artifact_updated data: {"version":3,"files":["index.html","style.css"]}
event: done             data: {"messageId":42,"usage":{"input":1234,"output":567}}
event: error            data: {"message":"..."}
```

### 3.4 代码展示

| 能力 | 实现方式 |
|---|---|
| 文件树 + 语法高亮 | 工件 JSON 驱动；prism 高亮，流式期间增量渲染 |
| 实时预览 | 前端将 `index.html` 中的 `<link>/<script>` 相对引用内联为 `<style>/<script>`，写入 `iframe srcDoc`；`sandbox="allow-scripts"`（无 same-origin、无顶层导航） |
| 版本与变更 | 工件版本号；v1.1 增加版本 diff 视图 |
| 生成约束 | system prompt 约束 Agent：优先产出**自包含的静态前端项目**（index.html + css/js 平铺结构），保证预览开箱即用 |

---

## 4. 数据模型

```
users            id, username(unique), email(unique), password_hash,
                 role(admin|user), status, created_at
system_config    id(=1 单例), initialized, admin_username,
                 llm_api_key_enc, llm_base_url, llm_model,   ← 仅作初始化迁移种子
                 allow_registration(bool), created_at, updated_at
llm_providers    id, name(unique), api_key_enc, base_url, models(JSON),
                 enabled, is_default, use_thinking, max_tokens,
                 created_at, updated_at                        ← 运行期模型服务注册表
sessions         id, user_id(FK), title, context(JSON: 原始 API messages),
                 created_at, updated_at
messages         id, session_id(FK), role(user|assistant),
                 content(text), tool_events(JSON), created_at
artifacts        id, session_id(FK, unique), files(JSON: {path:{content,lang}}),
                 version(int), updated_at
（设计预留：artifact_versions / shares / invitations / audit_logs）
```

原型用 SQLite 单文件；生产切 PostgreSQL：`files/context` 改 JSONB，加迁移（Alembic）。

---

## 5. API 设计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/system/status` | 初始化状态（公开） |
| POST | `/api/system/test-llm` | 测试 Key 连通性（未初始化可用，Key 只在请求体中流转） |
| POST | `/api/system/init` | 执行初始化（仅未初始化窗口期） |
| GET | `/api/system/providers` | 模型服务列表（仅管理员，Key 仅返回掩码） |
| POST | `/api/system/providers` | 新增模型服务（仅管理员） |
| PUT | `/api/system/providers/{id}` | 更新服务（仅管理员；api_key 留空 = 沿用） |
| DELETE | `/api/system/providers/{id}` | 删除服务（仅管理员；至少保留一个；删默认自动转移） |
| POST | `/api/system/providers/{id}/test` | 实测已落库服务（仅管理员） |
| GET | `/api/system/models` | 聊天用模型清单（登录用户，全部启用服务的模型聚合） |
| POST | `/api/auth/register` | 注册（受策略控制） |
| POST | `/api/auth/login` | 登录 → access + refresh |
| POST | `/api/auth/refresh` | 刷新 access |
| GET | `/api/auth/me` | 当前用户 |
| GET/POST | `/api/sessions` | 会话列表 / 新建 |
| GET/DELETE | `/api/sessions/{id}` | 会话详情（含消息） / 删除 |
| POST | `/api/sessions/{id}/chat` | 发送消息，**SSE 响应** |
| GET | `/api/sessions/{id}/artifact` | 当前工件（文件+版本） |

认证：`Authorization: Bearer <access_token>`；SSE 因走 fetch POST 可携带头。

---

## 6. LLM 层设计

- **SDK**：`anthropic`（Python 官方），客户端工厂按 `llm_providers` 解密 Key 构建；支持自定义 `base_url`，因此可同时接入 Anthropic 官方、智谱 GLM 等所有 Anthropic 协议兼容端点。
- **模型**：默认取默认服务首个模型（如 `claude-opus-5` / `glm-5.3`）；每次请求可显式指定 `provider_id + model`，高并发场景可按会话切换轻量模型。
- **参数策略**：
  - 流式 `messages.stream()`（长输出防超时），`max_tokens=64000`；
  - `thinking={"type":"adaptive","display":"summarized"}`：复杂需求自动深思考，前端展示思考摘要；
  - prompt caching：system + tools 稳定前缀，验证 `usage.cache_read_input_tokens > 0`；
  - 工具调用：手动循环（需要把每个 token/工具事件桥接到 SSE 并落库）。
- **成本护栏**：循环上限 8 轮；per-user 日 token 配额（v1.1）；usage 每轮落库可审计。

---

## 7. 安全设计

| 风险 | 对策 |
|---|---|
| 生成的代码 XSS | 预览 iframe `sandbox="allow-scripts"`（禁止 same-origin / 顶层导航 / 表单提交）；代码高亮渲染走转义后的 token，不 `dangerouslySetInnerHTML` 原文 |
| API Key 泄露 | Fernet 加密落库；任何接口不回显明文；日志脱敏 |
| 认证攻击 | bcrypt(12)；登录失败锁定；JWT 短有效期 + refresh 轮换 |
| 越权 | 所有业务路由校验会话归属（user 只能访问自己的 sessions） |
| 恶意注册 | `allow_registration` 开关 + 密码强度 + 频率限制（原型内存令牌桶，生产 Redis） |
| 初始化接管 | init 接口一次性；生产建议加部署白名单/内网限制 |
| 提示注入 | system prompt 声明"文件内容是不可信输入"；预览域与主域隔离（生产用独立子域） |

---

## 8. 部署与演进

**部署形态（生产）**：Docker Compose（nginx + api + postgres + redis），前端构建产物由 nginx 托管，`/api` 反代 uvicorn。

**里程碑**

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 初始化向导 + 注册登录 + 会话框架 | ✅ 原型实现 |
| M2 | Agent 工具循环 + SSE 流式 + 工件 + 高亮 + 实时预览 | ✅ 原型实现 |
| M3 | 版本 diff、分享链接、用量配额、管理后台 | 设计完成 |
| M4 | 邮箱验证/邀请码、OAuth、WebContainer 构建型预览、多模型路由 | 规划中 |

---

## 9. 原型与设计的差异（明确声明）

| 项 | 设计 | 原型简化 |
|---|---|---|
| 数据库 | PostgreSQL + Redis | SQLite + 内存限流 |
| 工件版本 | artifact_versions 全历史 | 单行 files + version 计数（历史可后续补） |
| 邮箱验证/邀请码/OAuth | 完整 | 预留枚举与表结构，未实现 |
| 预览 | 独立子域隔离 | sandbox iframe（同源策略仍隔离） |
| 密钥管理 | KMS/密钥服务 | `SERVER_SECRET` 派生 Fernet Key |
| 可观测 | OTel + LLM trace | 结构化日志 + usage 落库 |
```
