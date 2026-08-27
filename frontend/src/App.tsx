import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Setup from "./pages/Setup";
import Workspace from "./pages/Workspace";
import type { SystemStatus, User } from "./types";

export default function App() {
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api("/api/system/status");
        setStatus(s);
        if (s.initialized) {
          try {
            setUser(await api("/api/auth/me"));
          } catch {
            /* 未登录，正常 */
          }
        }
      } catch {
        /* 后端不可达时保持 null，路由兜底 */
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  if (booting) return <div className="boot-screen">CodeForge 启动中…</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/setup"
          element={
            status?.initialized ? (
              <Navigate to="/" replace />
            ) : (
              <Setup
                onDone={(u) => {
                  setUser(u);
                  setStatus((prev) => ({
                    initialized: true,
                    allow_registration: prev?.allow_registration ?? true,
                  }));
                }}
              />
            )
          }
        />
        {/* 登录/注册成功（user 被设置）后自动进入工作台，否则停在表单页"无反应" */}
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={setUser} />}/>
        <Route path="/register" element={user ? <Navigate to="/" replace /> : <Register onRegister={setUser} />} />
        <Route
          path="/"
          element={
            !status?.initialized ? (
              <Navigate to="/setup" replace />
            ) : user ? (
              <Workspace user={user} onLogout={() => setUser(null)} />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
