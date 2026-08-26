import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, saveTokens } from "../api";
import type { SystemStatus, User } from "../types";

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);

  useEffect(() => {
    api("/api/system/status")
      .then((s: SystemStatus) => setAllowRegistration(s.allow_registration))
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const t = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      saveTokens(t);
      onLogin(t.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-line">
          <div className="brand-logo">CF</div>
          <div>
            <h1 style={{ fontSize: 18, margin: 0 }}>登录 CodeForge</h1>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>代码生成与展示工作台</div>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label>用户名</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>密码</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn primary" style={{ width: "100%" }} disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        {allowRegistration && (
          <div className="switch-line">
            还没有账号？<Link to="/register">注册</Link>
          </div>
        )}
      </form>
    </div>
  );
}
