import { useState } from "react";
import { api, saveTokens } from "../api";
import type { User } from "../types";

const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

/** 接入预设：官方直连 / 智谱 GLM Coding Plan（Anthropic 协议兼容端点）。 */
const PRESETS = [
  {
    label: "Anthropic 官方",
    base_url: "",
    model: "claude-opus-5",
    hint: "官方 Key（sk-ant-…），直连 api.anthropic.com",
  },
  {
    label: "智谱 GLM Coding Plan",
    base_url: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-5.3",
    hint: "Anthropic 兼容端点；注意 Coding Plan 额度官方限定指定编程工具，自建应用若被拒请改用充值 Key",
  },
];

export default function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");

  const [admin, setAdmin] = useState({ username: "", email: "", password: "", confirm: "" });
  const [llm, setLlm] = useState({ api_key: "", base_url: "", model: "claude-opus-5" });
  const [allowRegistration, setAllowRegistration] = useState(true);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [presetHint, setPresetHint] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const step1Valid =
    admin.username.trim().length >= 3 &&
    admin.email.includes("@") &&
    admin.password.length >= 8 &&
    admin.password === admin.confirm;

  const next = () => {
    setError("");
    if (step === 1) {
      if (!step1Valid) {
        setError("请完整填写管理员信息：用户名≥3位、邮箱合法、密码≥8位且两次一致");
        return;
      }
    }
    setStep(step + 1);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api("/api/system/test-llm", {
        method: "POST",
        body: JSON.stringify({
          api_key: llm.api_key.trim(),
          base_url: llm.base_url.trim() || null,
          model: llm.model.trim(),
        }),
      });
      setTestResult({ ok: r.ok, detail: r.detail + (r.reply ? `（模型回复：${r.reply}）` : "") });
    } catch (e: any) {
      setTestResult({ ok: false, detail: e.message });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setError("");
    if (llm.api_key.trim().length < 8) {
      setError("请填写有效的 API Key");
      return;
    }
    setSubmitting(true);
    try {
      const t = await api("/api/system/init", {
        method: "POST",
        body: JSON.stringify({
          admin: { username: admin.username.trim(), email: admin.email.trim(), password: admin.password },
          llm: { api_key: llm.api_key.trim(), base_url: llm.base_url.trim() || null, model: llm.model.trim() },
          allow_registration: allowRegistration,
        }),
      });
      saveTokens(t);
      onDone(t.user);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand-line">
          <div className="brand-logo">CF</div>
          <div>
            <h1 style={{ fontSize: 18, margin: 0 }}>CodeForge 初始化</h1>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>首次部署，3 步完成</div>
          </div>
        </div>

        <div className="stepper">
          {[1, 2, 3].map((n) => (
            <div key={n} className={`step ${step === n ? "active" : step > n ? "done" : ""}`}>
              {step > n ? "✓ " : `${n}. `}
              {["管理员", "模型配置", "注册策略"][n - 1]}
            </div>
          ))}
        </div>

        {error && <div className="form-error">{error}</div>}

        {step === 1 && (
          <>
            <div className="field">
              <label>管理员用户名</label>
              <input
                className="input"
                value={admin.username}
                onChange={(e) => setAdmin({ ...admin, username: e.target.value })}
                placeholder="admin"
              />
            </div>
            <div className="field">
              <label>管理员邮箱</label>
              <input
                className="input"
                value={admin.email}
                onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                placeholder="admin@example.com"
              />
            </div>
            <div className="field">
              <label>密码</label>
              <input
                className="input"
                type="password"
                value={admin.password}
                onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
                placeholder="至少 8 位，含字母与数字"
              />
            </div>
            <div className="field">
              <label>确认密码</label>
              <input
                className="input"
                type="password"
                value={admin.confirm}
                onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })}
              />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="field">
              <label>服务预设</label>
              <div className="chip-row">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="chip"
                    onClick={() => {
                      setLlm({ ...llm, base_url: p.base_url, model: p.model });
                      setPresetHint(p.hint);
                      setTestResult(null);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {presetHint && <div className="hint">{presetHint}</div>}
            </div>
            <div className="field">
              <label>API Key</label>
              <input
                className="input"
                type="password"
                value={llm.api_key}
                onChange={(e) => setLlm({ ...llm, api_key: e.target.value })}
                placeholder="sk-ant-… 或对应服务的 API Key"
              />
              <div className="hint">将以 AES-256 加密存储，不会出现在任何接口返回中</div>
            </div>
            <div className="field">
              <label>Base URL（可选，Anthropic 协议兼容端点；留空 = 官方地址）</label>
              <input
                className="input"
                value={llm.base_url}
                onChange={(e) => setLlm({ ...llm, base_url: e.target.value })}
                placeholder="https://open.bigmodel.cn/api/anthropic"
              />
            </div>
            <div className="field">
              <label>默认模型</label>
              <input
                className="input mono"
                value={llm.model}
                onChange={(e) => setLlm({ ...llm, model: e.target.value })}
                list="model-suggestions"
                placeholder="claude-opus-5 / glm-5.3 / …"
              />
              <datalist id="model-suggestions">
                {[...MODELS, "glm-5.3", "glm-5.3[1m]", "glm-4.7", "glm-4.6"].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <div className="hint">初始化后可在「模型服务管理」中添加更多服务与模型</div>
            </div>
            <button className="btn" onClick={runTest} disabled={testing || llm.api_key.trim().length < 8}>
              {testing ? "测试中…" : "测试连接"}
            </button>
            {testResult && (
              <div className={`test-result ${testResult.ok ? "ok" : "bad"}`}>
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.detail}
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div className="field">
              <label>注册策略</label>
              <div style={{ display: "flex", gap: 20, padding: "6px 0" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    checked={allowRegistration}
                    onChange={() => setAllowRegistration(true)}
                  />
                  开放注册
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    checked={!allowRegistration}
                    onChange={() => setAllowRegistration(false)}
                  />
                  关闭注册（仅管理员账号可用）
                </label>
              </div>
              <div className="hint">后续版本将支持邀请码模式；此处决定 /register 页面是否可用</div>
            </div>
            <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <label>配置摘要</label>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.9 }}>
                管理员：{admin.username}（{admin.email}）
                <br />
                模型：{llm.model}
                <br />
                Base URL：{llm.base_url.trim() || "默认（api.anthropic.com）"}
                <br />
                注册：{allowRegistration ? "开放" : "关闭"}
              </div>
            </div>
          </>
        )}

        <div className="wizard-actions">
          <button className="btn ghost" onClick={() => setStep(step - 1)} disabled={step === 1 || submitting}>
            上一步
          </button>
          {step < 3 ? (
            <button className="btn primary" onClick={next}>
              下一步
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={submitting}>
              {submitting ? "初始化中…" : "完成初始化"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
