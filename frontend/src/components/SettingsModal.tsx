import { useEffect, useState } from "react";
import { api } from "../api";
import type { Provider } from "../types";

/** 常用服务预设：一键填充接入参数（均为 Anthropic 协议兼容端点）。 */
const PRESETS = [
  {
    label: "Anthropic 官方",
    name: "Anthropic 官方",
    base_url: "",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    use_thinking: true,
    max_tokens: 64000,
    hint: "官方 Key（sk-ant-…），直连 api.anthropic.com",
  },
  {
    label: "智谱 GLM Coding Plan",
    name: "智谱 GLM",
    base_url: "https://open.bigmodel.cn/api/anthropic",
    models: ["glm-5.3", "glm-5.3[1m]", "glm-4.7", "glm-4.6"],
    use_thinking: true,
    max_tokens: 64000,
    hint: "Anthropic 兼容端点；Coding Plan 套餐额度官方限定指定编程工具，自建应用若被拒请改用充值 Key",
  },
];

interface FormState {
  name: string;
  api_key: string;
  base_url: string;
  models: string; // 逗号分隔
  enabled: boolean;
  is_default: boolean;
  use_thinking: boolean;
  max_tokens: number;
}

const EMPTY_FORM: FormState = {
  name: "",
  api_key: "",
  base_url: "",
  models: "",
  enabled: true,
  is_default: false,
  use_thinking: true,
  max_tokens: 64000,
};

/**
 * 模型服务管理弹窗（仅管理员）：接入多个 LLM 服务（Anthropic 官方 /
 * 智谱 GLM / 任意 Anthropic 兼容网关），每个服务独立 Key、Base URL 与模型列表。
 */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Provider | null>(null); // null = 未在编辑
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = async () => {
    try {
      setProviders(await api("/api/system/providers"));
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const startCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError("");
    setTestResult(null);
    setNotice("");
  };

  const startEdit = (p: Provider) => {
    setEditing(p);
    setForm({
      name: p.name,
      api_key: "",
      base_url: p.base_url ?? "",
      models: p.models.join(", "),
      enabled: p.enabled,
      is_default: p.is_default,
      use_thinking: p.use_thinking,
      max_tokens: p.max_tokens,
    });
    setShowForm(true);
    setError("");
    setTestResult(null);
    setNotice("");
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setForm((f) => ({
      ...f,
      name: preset.name,
      base_url: preset.base_url,
      models: preset.models.join(", "),
      use_thinking: preset.use_thinking,
      max_tokens: preset.max_tokens,
    }));
    setNotice(preset.hint);
    setTestResult(null);
  };

  const parsedModels = () => form.models.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);

  const runTest = async () => {
    const models = parsedModels();
    if (!models.length) {
      setError("请至少填写一个模型 ID");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // 填了新 Key → 实测候选值；编辑既有服务且未填 Key → 实测已落库配置
      const r = form.api_key.trim()
        ? await api("/api/system/test-llm", {
            method: "POST",
            body: JSON.stringify({
              api_key: form.api_key.trim(),
              base_url: form.base_url.trim() || null,
              model: models[0],
            }),
          })
        : editing
          ? await api(`/api/system/providers/${editing.id}/test?model=${encodeURIComponent(models[0])}`, {
              method: "POST",
            })
          : null;
      if (r) {
        setTestResult({ ok: r.ok, detail: r.detail + (r.reply ? `（模型回复：${r.reply}）` : "") });
      } else {
        setError("新增服务请先填写 API Key 再测试");
      }
    } catch (e: any) {
      setTestResult({ ok: false, detail: e.message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError("");
    setNotice("");
    const models = parsedModels();
    if (!form.name.trim()) {
      setError("请填写服务名称");
      return;
    }
    if (!editing && form.api_key.trim().length < 8) {
      setError("新增服务必须填写 API Key（至少 8 位）");
      return;
    }
    if (!models.length) {
      setError("请至少填写一个模型 ID（逗号分隔）");
      return;
    }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      api_key: form.api_key.trim() || null,
      base_url: form.base_url.trim(), // 空串 = 官方地址（更新时空串表示清除，null 表示不修改）
      models,
      enabled: form.enabled,
      is_default: form.is_default,
      use_thinking: form.use_thinking,
      max_tokens: form.max_tokens,
    };
    try {
      await api(editing ? `/api/system/providers/${editing.id}` : "/api/system/providers", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setShowForm(false);
      setEditing(null);
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Provider) => {
    setError("");
    try {
      await api(`/api/system/providers/${p.id}`, { method: "DELETE" });
      if (editing?.id === p.id) {
        setShowForm(false);
        setEditing(null);
      }
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const testStored = async (p: Provider) => {
    setTestResult(null);
    try {
      const r = await api(`/api/system/providers/${p.id}/test`, { method: "POST" });
      setTestResult({ ok: r.ok, detail: `${p.name}：${r.detail}` });
    } catch (e: any) {
      setTestResult({ ok: false, detail: e.message });
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ fontSize: 16, margin: 0 }}>模型服务管理</h2>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              接入多个 LLM 服务（Anthropic / 智谱 GLM / 任意 Anthropic 兼容网关），聊天时可选模型
            </div>
          </div>
          <button className="btn ghost small" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}
        {notice && !showForm && <div className="test-result ok">✓ {notice}</div>}

        <div className="provider-list">
          {providers.map((p) => (
            <div key={p.id} className={`provider-row ${p.enabled ? "" : "disabled"}`}>
              <div className="provider-main">
                <div className="provider-name">
                  {p.name}
                  {p.is_default && <span className="tag default">默认</span>}
                  {!p.enabled && <span className="tag">已停用</span>}
                </div>
                <div className="provider-meta">
                  {p.base_url || "api.anthropic.com"} · Key {p.api_key_masked}
                </div>
                <div className="provider-models">
                  {p.models.map((m) => (
                    <span key={m} className="model-chip">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
              <div className="provider-ops">
                <button className="btn ghost small" onClick={() => testStored(p)}>
                  测试
                </button>
                <button className="btn ghost small" onClick={() => startEdit(p)}>
                  编辑
                </button>
                <button className="btn ghost small danger" onClick={() => remove(p)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {providers.length === 0 && (
            <div className="empty" style={{ padding: "12px 0" }}>尚无模型服务</div>
          )}
        </div>

        {!showForm ? (
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={startCreate}>
              ＋ 接入新服务
            </button>
          </div>
        ) : (
          <div className="provider-form">
            <div className="field">
              <label>快速预设</label>
              <div className="chip-row">
                {PRESETS.map((p) => (
                  <button key={p.label} className="chip" onClick={() => applyPreset(p)}>
                    {p.label}
                  </button>
                ))}
                <button className="chip" onClick={() => setNotice("自定义服务：填写任意 Anthropic 协议兼容端点")}>
                  自定义
                </button>
              </div>
              {notice && <div className="hint">{notice}</div>}
            </div>
            <div className="field">
              <label>服务名称</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：智谱 GLM"
              />
            </div>
            <div className="field">
              <label>API Key</label>
              <input
                className="input"
                type="password"
                value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                placeholder={
                  editing ? `当前：${editing.api_key_masked}，留空保持不变` : "sk-ant-… 或 智谱 API Key"
                }
              />
              <div className="hint">AES-256 加密落库，任何接口不回显完整 Key</div>
            </div>
            <div className="field">
              <label>Base URL（Anthropic 协议兼容端点，留空 = 官方地址）</label>
              <input
                className="input"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://open.bigmodel.cn/api/anthropic"
              />
            </div>
            <div className="field">
              <label>模型列表（逗号分隔，第一个为该服务默认模型）</label>
              <input
                className="input mono"
                value={form.models}
                onChange={(e) => setForm({ ...form, models: e.target.value })}
                placeholder="glm-5.3, glm-4.7, glm-4.6"
              />
            </div>
            <div className="field">
              <label>max_tokens（单次流式输出上限）</label>
              <input
                className="input"
                type="number"
                value={form.max_tokens}
                onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) || 64000 })}
              />
            </div>
            <div className="field">
              <label>选项</label>
              <div className="check-row">
                <label>
                  <input
                    type="checkbox"
                    checked={form.use_thinking}
                    onChange={(e) => setForm({ ...form, use_thinking: e.target.checked })}
                  />
                  请求携带 thinking 参数（兼容端点不支持时取消）
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  启用
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.is_default}
                    onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
                  />
                  设为默认服务
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={runTest} disabled={testing}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setShowForm(false);
                    setEditing(null);
                    setNotice("");
                  }}
                >
                  取消
                </button>
                <button className="btn primary" onClick={save} disabled={saving}>
                  {saving ? "保存中…" : editing ? "保存修改" : "添加服务"}
                </button>
              </div>
            </div>
          </div>
        )}

        {testResult && (
          <div className={`test-result ${testResult.ok ? "ok" : "bad"}`}>
            {testResult.ok ? "✓ " : "✗ "}
            {testResult.detail}
          </div>
        )}
      </div>
    </div>
  );
}
