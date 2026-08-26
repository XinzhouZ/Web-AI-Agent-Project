import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, saveTokens } from "../api";
import type { SystemStatus, User } from "../types";

export default function Register({ onRegister }: { onRegister: (user: User) => void }) {
  const [form, setForm] = useState({ username: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    api("/api/system/status")
      .then((s: SystemStatus) => {
        setOpen(s.allow_registration);
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const t = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username: form.username.trim(),
          email: form.email.trim(),
          password: form.password,
        }),
      });
      saveTokens(t);
      onRegister(t.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 18 }}>注册已关闭</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>管理员未开放注册，请联系管理员开通账号。</p>
          <Link to="/login">返回登录</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-line">
          <div className="brand-logo">CF</div>
          <div>
            <h1 style={{ fontSize: 18, margin: 0 }}>注册 CodeForge</h1>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>创建账号即可开始生成代码</div>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label>用户名（3-50 位字母/数字/下划线）</label>
          <input
            className="input"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            autoFocus
          />
        </div>
        <div className="field">
          <label>邮箱</label>
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div className="field">
          <label>密码（至少 8 位，含字母与数字）</label>
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
        <div className="field">
          <label>确认密码</label>
          <input
            className="input"
            type="password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          />
        </div>
        <button
          className="btn primary"
          style={{ width: "100%" }}
          disabled={busy || !form.username || !form.email || !form.password}
        >
          {busy ? "注册中…" : "注册并登录"}
        </button>
        <div className="switch-line">
          已有账号？<Link to="/login">登录</Link>
        </div>
      </form>
    </div>
  );
}
