/**
 * API 客户端：Bearer 认证 + 401 自动刷新 + SSE 流式解析。
 */
import type { Tokens } from "./types";

const ACCESS_KEY = "cf_access";
const REFRESH_KEY = "cf_refresh";

export function getAccess(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function saveTokens(t: Tokens) {
  localStorage.setItem(ACCESS_KEY, t.access_token);
  localStorage.setItem(REFRESH_KEY, t.refresh_token);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

async function tryRefresh(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return false;
    saveTokens(await res.json());
    return true;
  } catch {
    return false;
  }
}

async function extractError(res: Response): Promise<Error> {
  let detail: unknown = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    if (j && j.detail) detail = j.detail;
  } catch {
    /* 保留状态码信息 */
  }
  return new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
}

export async function api(path: string, opts: RequestInit = {}, retry = true): Promise<any> {
  const token = getAccess();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && retry && (await tryRefresh())) {
    return api(path, opts, false);
  }
  if (res.status === 401) clearTokens();
  if (!res.ok) throw await extractError(res);
  return res.status === 204 ? null : res.json();
}

/**
 * SSE 聊天流：POST + ReadableStream 手工解析 text/event-stream。
 * （不用 EventSource，因为它无法携带 Authorization 头与 POST body）
 */
export async function streamChat(
  sessionId: number,
  content: string,
  onEvent: (event: string, data: any) => void,
  opts: { provider_id?: number | null; model?: string | null } = {}
): Promise<void> {
  const doFetch = () => {
    const token = getAccess();
    return fetch(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        content,
        provider_id: opts.provider_id ?? null,
        model: opts.model ?? null,
      }),
    });
  };

  let res = await doFetch();
  if (res.status === 401 && (await tryRefresh())) res = await doFetch();
  if (!res.ok || !res.body) throw await extractError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handleBlock = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) {
      try {
        onEvent(event, JSON.parse(dataLines.join("\n")));
      } catch {
        /* 忽略无法解析的块 */
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) handleBlock(block);
    }
  }
  if (buf.trim()) handleBlock(buf);
}
