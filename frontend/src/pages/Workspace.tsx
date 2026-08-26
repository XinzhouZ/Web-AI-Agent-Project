import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { api, clearTokens, streamChat } from "../api";
import CodeView from "../components/CodeView";
import Preview, { buildSrcDoc } from "../components/Preview";
import SettingsModal from "../components/SettingsModal";
import { THEMES, getTheme, setTheme, type ThemeId } from "../theme";
import type { Artifact, ChatMessage, ModelOption, SessionSummary, User } from "../types";

const SAMPLES = [
  "做一个深色主题的番茄钟，带 25 分钟计时、暂停/重置和当日统计",
  "写一个可拖拽排序的待办清单，数据保存在 localStorage",
  "做一个响应式的个人主页，包含头像卡片、技能进度条和作品网格",
];

interface LiveAssistant {
  status: string; // thinking | generating | tool
  content: string;
  thinking: string;
  tools: { name: string; path: string | null }[];
}

const STATUS_TEXT: Record<string, string> = {
  thinking: "🧠 思考中…",
  generating: "✍️ 生成中…",
  tool: "🔧 正在写入文件…",
};

export default function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeTitle, setActiveTitle] = useState("工作台");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [artifact, setArtifact] = useState<Artifact>({ version: 0, files: {} });
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveAssistant | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelKey, setModelKey] = useState(() => localStorage.getItem("cf_model") ?? "");
  const [copied, setCopied] = useState(false);
  const [theme, setThemeState] = useState<ThemeId>(getTheme());
  const listRef = useRef<HTMLDivElement>(null);

  const changeTheme = (id: ThemeId) => {
    setTheme(id);
    setThemeState(id);
  };
  const [atBottom, setAtBottom] = useState(true);

  const scrollToEnd = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const refreshSessions = async () => {
    try {
      setSessions(await api("/api/sessions"));
    } catch {
      /* 静默 */
    }
  };

  // 可选模型 = 全部启用服务下的所有模型；记住上次选择，失配时回退默认
  const loadModels = async () => {
    try {
      const list: ModelOption[] = await api("/api/system/models");
      setModelOptions(list);
      setModelKey((prev) => {
        if (prev && list.some((o) => `${o.provider_id}:${o.model}` === prev)) return prev;
        const def = list.find((o) => o.is_default) ?? list[0];
        const next = def ? `${def.provider_id}:${def.model}` : "";
        localStorage.setItem("cf_model", next);
        return next;
      });
    } catch {
      /* 静默：聊天时后端会兜底默认服务 */
    }
  };

  useEffect(() => {
    refreshSessions();
    loadModels();
  }, []);

  // 新消息/流式增量时跟随滚动——仅当用户本就停留在底部附近，不打断向上翻阅
  useEffect(() => {
    if (atBottom) scrollToEnd();
  }, [messages, live, atBottom]);

  const openSession = async (sid: number) => {
    if (streaming) return;
    setActiveId(sid);
    try {
      const [detail, art] = await Promise.all([
        api(`/api/sessions/${sid}`),
        api(`/api/sessions/${sid}/artifact`),
      ]);
      setActiveTitle(detail.title);
      setMessages(detail.messages);
      setArtifact(art);
      const paths = Object.keys(art.files);
      setActiveFile(paths.includes("index.html") ? "index.html" : paths[0] ?? null);
    } catch {
      /* 列表项可能已失效 */
    }
  };

  const reloadAfterTurn = async (sid: number) => {
    try {
      const [detail, art, list] = await Promise.all([
        api(`/api/sessions/${sid}`),
        api(`/api/sessions/${sid}/artifact`),
        api("/api/sessions"),
      ]);
      setActiveTitle(detail.title);
      setMessages(detail.messages);
      setArtifact(art);
      setSessions(list);
      setActiveFile((prev) => {
        const paths = Object.keys(art.files);
        if (prev && paths.includes(prev)) return prev;
        return paths.includes("index.html") ? "index.html" : paths[0] ?? null;
      });
    } catch {
      /* 忽略 */
    }
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput("");

    // 无会话则先创建
    let sid: number;
    if (activeId != null) {
      sid = activeId;
    } else {
      try {
        const s = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: null }) });
        sid = s.id;
        setActiveId(sid);
        setSessions((prev) => [s, ...prev]);
      } catch (e: any) {
        setMessages((prev) => [...prev, { role: "error", content: e.message }]);
        return;
      }
    }

    setMessages((prev) => [...prev, { role: "user", content }]);
    setStreaming(true);
    const liveState: LiveAssistant = { status: "thinking", content: "", thinking: "", tools: [] };
    setLive(liveState);

    const [pidStr, chosenModel] = modelKey.split(":");
    try {
      await streamChat(sid, content, (ev, data) => {
        if (ev === "text_delta") {
          liveState.content += data.delta;
          liveState.status = "generating";
          setLive({ ...liveState });
        } else if (ev === "thinking_delta") {
          liveState.thinking += data.delta;
          liveState.status = "thinking";
          setLive({ ...liveState });
        } else if (ev === "status") {
          liveState.status = data.stage;
          setLive({ ...liveState });
        } else if (ev === "tool_call") {
          liveState.tools.push({ name: data.name, path: data.path });
          if (data.path) setActiveFile(data.path);
          setLive({ ...liveState });
        } else if (ev === "artifact_updated") {
          if (data.changed) setActiveFile(data.changed);
        } else if (ev === "error") {
          setMessages((prev) => [...prev, { role: "error", content: data.message }]);
        }
        // done 事件由 finally 中的统一刷新兜底
      }, {
        provider_id: pidStr ? Number(pidStr) : null,
        model: chosenModel || null,
      });
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "error", content: e.message }]);
    } finally {
      setLive(null);
      setStreaming(false);
      await reloadAfterTurn(sid);
    }
  };

  const newSession = () => {
    if (streaming) return;
    setActiveId(null);
    setActiveTitle("工作台");
    setMessages([]);
    setArtifact({ version: 0, files: {} });
    setActiveFile(null);
  };

  const removeSession = async (sid: number) => {
    if (streaming || sid == null) return;
    try {
      await api(`/api/sessions/${sid}`, { method: "DELETE" });
      if (sid === activeId) newSession();
      await refreshSessions();
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "error", content: e.message }]);
    }
  };

  const logout = () => {
    clearTokens();
    onLogout();
  };

  // ---------- 导出：当前文件下载/复制 + 全部文件打包 ZIP ----------
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadCurrentFile = () => {
    if (!activeFile || !file) return;
    downloadBlob(new Blob([file.content], { type: "text/plain;charset=utf-8" }), activeFile);
  };

  const copyCurrentFile = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板权限被拒时静默 */
    }
  };

  const exportZip = async () => {
    if (Object.keys(artifact.files).length === 0) return;
    const zip = new JSZip();
    for (const [path, meta] of Object.entries(artifact.files)) {
      zip.file(path, meta.content);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const name = `${activeTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "codeforge"}-v${artifact.version}.zip`;
    downloadBlob(blob, name);
  };

  // 新标签页打开预览：同一份自包含 HTML（与 iframe srcDoc 相同）转为 Blob URL
  const openPreviewTab = () => {
    const html = buildSrcDoc(artifact.files);
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    window.open(url, "_blank", "noopener");
    // 延迟释放：给新标签页留出加载时间（Blob URL 不支持刷新后重载，属预期）
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const filePaths = Object.keys(artifact.files);
  const file = activeFile ? artifact.files[activeFile] : undefined;

  return (
    <div className="ws">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo" style={{ width: 26, height: 26, fontSize: 12, borderRadius: 7 }}>
            CF
          </div>
          CodeForge
        </div>
        <button className="btn primary" onClick={newSession} disabled={streaming}>
          ＋ 新会话
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => openSession(s.id)}
              title={s.title}
            >
              {s.title}
            </div>
          ))}
          {sessions.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "6px 4px" }}>暂无历史会话</div>
          )}
        </div>
        <div className="theme-row">
          <span>🎨 主题</span>
          <select
            className="model-select"
            value={theme}
            onChange={(e) => changeTheme(e.target.value as ThemeId)}
            title="切换界面主题颜色"
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sidebar-footer">
          <span>
            {user.username} · {user.role === "admin" ? "管理员" : "用户"}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {user.role === "admin" && (
              <button className="btn ghost small" onClick={() => setShowSettings(true)}>
                模型设置
              </button>
            )}
            <button className="btn ghost small" onClick={logout}>
              退出
            </button>
          </div>
        </div>
      </aside>

      <main className="chat">
        <header className="chat-title">
          <span>{activeTitle}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {modelOptions.length > 0 && (
              <select
                className="model-select"
                value={modelKey}
                disabled={streaming}
                onChange={(e) => {
                  setModelKey(e.target.value);
                  localStorage.setItem("cf_model", e.target.value);
                }}
                title="选择模型服务与模型"
              >
                {modelOptions.map((o) => (
                  <option key={`${o.provider_id}:${o.model}`} value={`${o.provider_id}:${o.model}`}>
                    {o.provider} · {o.model}
                    {o.is_default ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            )}
            {activeId != null && (
              <button className="btn ghost small" onClick={() => removeSession(activeId)} disabled={streaming}>
                删除会话
              </button>
            )}
          </div>
        </header>

        <div className="msg-list-wrap">
          <div className="msg-list" ref={listRef} onScroll={onListScroll}>
          {messages.length === 0 && !live && (
            <div className="welcome">
              <h2>你好，{user.username} 👋</h2>
              <p>描述你想要的前端页面，Agent 会生成代码并在右侧实时预览。</p>
              <div className="samples">
                {SAMPLES.map((s) => (
                  <div key={s} className="sample" onClick={() => send(s)}>
                    {s}
                  </div>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={m.id ?? `m${i}`} className={`msg ${m.role}`}>
              {m.role === "assistant" && <div className="who">CodeForge</div>}
              <div className="bubble">{m.content}</div>
              {m.role === "assistant" && (m.tool_events?.length ?? 0) > 0 && (
                <div className="tool-chips">
                  {m.tool_events!.map((t, j) => (
                    <span key={j} className="tool-chip">
                      {t.path} → v{t.version}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {live && (
            <div className="msg assistant">
              <div className="who">CodeForge</div>
              <div className="status-line">{STATUS_TEXT[live.status] ?? "处理中…"}</div>
              {live.thinking && (
                <details className="thinking-box" open={live.status === "thinking"}>
                  <summary>思考过程</summary>
                  <div className="thinking-text">{live.thinking}</div>
                </details>
              )}
              <div className="bubble">
                {live.content}
                {live.status === "generating" && <span className="stream-cursor" />}
              </div>
              {live.tools.length > 0 && (
                <div className="tool-chips">
                  {live.tools.map((t, j) => (
                    <span key={j} className="tool-chip">
                      {t.path ?? t.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          </div>
          {!atBottom && (
            <button className="scroll-bottom-btn" onClick={scrollToEnd} title="回到底部">
              ↓
            </button>
          )}
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder="描述你想要的页面，例如：做一个带深色模式的番茄钟…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={streaming}
          />
          <button className="btn primary" onClick={() => send()} disabled={streaming || !input.trim()}>
            {streaming ? "生成中…" : "发送"}
          </button>
        </div>
      </main>

      <section className="panel">
        <div className="panel-tabs">
          <button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>
            预览
          </button>
          <button className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}>
            代码 {artifact.version > 0 && `· v${artifact.version}`}
          </button>
          {filePaths.length > 0 && (
            <div className="panel-ops">
              <button className="btn ghost small" onClick={openPreviewTab} title="在浏览器新标签页中打开预览">
                ↗ 新标签页
              </button>
              <button className="btn ghost small" onClick={exportZip} title="打包下载全部项目文件">
                ⬇ 导出 ZIP
              </button>
            </div>
          )}
        </div>

        {tab === "preview" ? (
          <Preview artifact={artifact} />
        ) : filePaths.length === 0 ? (
          <div className="empty">尚无代码。发送需求后，生成的文件会出现在这里。</div>
        ) : (
          <>
            <div className="file-chips">
              {filePaths.map((p) => (
                <button
                  key={p}
                  className={`file-chip ${p === activeFile ? "active" : ""}`}
                  onClick={() => setActiveFile(p)}
                >
                  {p}
                </button>
              ))}
              <div className="file-chips-ops">
                <button className="btn ghost small" onClick={copyCurrentFile} disabled={!file}>
                  {copied ? "已复制 ✓" : "复制"}
                </button>
                <button className="btn ghost small" onClick={downloadCurrentFile} disabled={!file}>
                  下载文件
                </button>
              </div>
            </div>
            {file ? (
              <CodeView code={file.content} language={file.language} theme={theme} />
            ) : (
              <div className="empty">选择一个文件</div>
            )}
          </>
        )}
      </section>

      {showSettings && (
        <SettingsModal
          onClose={() => {
            setShowSettings(false);
            loadModels(); // 服务/模型可能已变更
          }}
        />
      )}
    </div>
  );
}
