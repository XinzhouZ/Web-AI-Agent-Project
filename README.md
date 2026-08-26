# CodeForge — 代码生成与展示 Web AI Agent

自然语言描述需求 → Claude Agent 生成多文件前端代码 → 浏览器实时预览。
包含完整的**系统初始化**、**注册/登录**、**会话式代码生成**流程。

> 架构与流程的完整设计见 [DESIGN.md](./DESIGN.md)。

## 技术栈

| 端 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + prism-react-renderer + JSZip（导出） |
| 后端 | FastAPI + SQLAlchemy（SQLite，可切 PostgreSQL） |
| 模型 | 多服务接入：Anthropic Claude 官方 / 智谱 GLM（Coding Plan，Anthropic 协议兼容端点）/ 任意兼容网关 |
| 认证 | JWT（access 30min / refresh 7d）+ bcrypt |

## 目录结构

```
Demo/
├── DESIGN.md              # 设计文档（架构 / 流程 / 数据模型 / API / 安全）
├── backend/
│   ├── app/
│   │   ├── main.py        # 入口：CORS、初始化守卫中间件
│   │   ├── config.py      # 环境配置（SERVER_SECRET 等）
│   │   ├── models.py      # User / SystemConfig / ChatSession / Message / Artifact
│   │   ├── security.py    # bcrypt / JWT / Fernet 密钥加密
│   │   ├── llm.py         # Claude 客户端工厂 + 连通性测试
│   │   ├── agent.py       # Agent 工具循环 → SSE 事件流（核心）
│   │   ├── system_routes.py   # /api/system/*（初始化三步）
│   │   ├── auth_routes.py     # /api/auth/*（注册/登录/刷新）
│   │   └── session_routes.py  # /api/sessions/*（会话/工件/SSE chat）
│   └── requirements.txt
└── frontend/
    └── src/
        ├── App.tsx            # 启动路由守卫（未初始化→/setup，未登录→/login）
        ├── api.ts             # fetch 封装 + 401 自动刷新 + SSE 流解析
        ├── pages/Setup.tsx    # 初始化向导（管理员/模型/注册策略）
        ├── pages/Login.tsx / Register.tsx
        ├── pages/Workspace.tsx # 工作台：会话 + 流式对话 + 文件 + 预览
        └── components/CodeView.tsx / Preview.tsx / SettingsModal.tsx
```

## 快速开始

### 1. 启动后端（端口 8000）

```powershell
cd backend
# 已在开发中创建 .venv；全新环境可用：python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

可选：复制 `.env.example` 为 `.env`，设置 `SERVER_SECRET`（生产必改；
该密钥同时用于 JWT 签名与 API Key 加密落库）。

### 2. 启动前端（端口 5173）

```powershell
cd frontend
npm install      # 已安装过可跳过
npm run dev
```

浏览器访问 **http://localhost:5173**。

### 3. 演示流程

1. **初始化向导**（首次自动进入 `/setup`）
   - 管理员账号 → Anthropic API Key（可点「测试连接」实时验证）→ 注册策略
   - Key 经 AES-256 加密落库；初始化接口此后永久关闭（403）
2. **注册 / 登录**：向导完成后自动以管理员登录；其他用户经 `/register` 注册（受策略控制）
3. **生成代码**：工作台输入需求（如「做一个深色主题的番茄钟」）
   - 左侧：流式思考摘要 + 回复 + 写入文件的事件
   - 右侧：「预览」标签实时渲染（sandbox iframe）；「代码」标签查看语法高亮的多文件
4. **对话迭代**：继续提需求（如「按钮改成圆角」），工件版本号递增
5. **导出代码**：面板右上「⬇ 导出 ZIP」打包全部项目文件（文件名含会话标题与版本号）；
   「代码」标签内可复制或单独下载当前文件
6. **新标签页预览**：面板右上「↗ 新标签页」把当前预览的页面在浏览器新标签页中完整打开
   （Blob URL，与 iframe 预览同一份自包含 HTML；在真实浏览器环境中查看效果）
7. **主题切换**：侧边栏底部「🎨 主题」——深色（默认）/ 浅色 / 暗夜蓝 / 浅绿，
   选择持久化（localStorage），代码高亮配色随主题明暗联动，登录/初始化页同样生效
5. **接入更多模型服务**（管理员）：侧边栏「模型设置」→ 模型服务管理
   - 支持同时接入多个服务：Anthropic 官方 / 智谱 GLM（Coding Plan）/ 任意 Anthropic 协议兼容网关
   - 每个服务独立 Key（AES 加密落库）、Base URL、模型列表；一键预设模板填充智谱端点
   - 聊天输入框上方的模型选择器可随时切换「服务 · 模型」，随每条消息生效
   - 注意：智谱 Coding Plan 套餐额度官方限定指定编程工具，自建应用若被拒请改用充值 Key

## 安全要点

- 生成的代码仅在 `sandbox="allow-scripts"` 的 iframe 中渲染（禁 same-origin / 顶层导航 / 表单）
- API Key 密文落库，任何接口不回显；未初始化时全部业务 API 返回 403
- 会话归属校验（越权访问返回 404）；登录失败 5 次锁定 15 分钟
- Agent 工具循环上限 8 轮（成本护栏）；文件路径经目录穿越校验

## 已验证 / 未验证

- ✅ 后端全流程冒烟：初始化→防重复初始化→注册→登录→刷新→建会话→工件查询
- ✅ 模型服务注册表 E2E：初始化种子服务 / 增删改查 / 普通用户 403 / 留空 Key 沿用 / 删默认自动转移 / 禁止删最后一个 / 聊天按「服务+模型」调用 / 模型清单双端聚合
- ✅ 前端 `tsc` 类型检查 + 生产构建；vite 代理与 API 联调
- ⚠️ 真实 LLM 生成链路（SSE 流式 + write_file 工具循环）需要有效 Anthropic API Key，
  请在初始化向导中填入后体验
