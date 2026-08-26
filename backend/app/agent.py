"""Agent 编排核心：Claude 工具循环 → SSE 事件流。

设计要点：
- 手动 tool loop（而非 tool runner）：需要把每个 token / 工具事件桥接到 SSE 并落库；
- system 前缀（角色 prompt + 工具定义）稳定，挂 cache_control 做 prompt caching，
  工件文件清单放在第二个 system 块（缓存断点之后），文件变化不破坏前缀缓存；
- 会话上下文持久化「原始 API messages」（含 tool_use/tool_result 块），多轮保真。
"""
import json
from datetime import datetime, timezone

import anthropic
from sqlalchemy import select

from .database import SessionLocal
from .llm import build_client
from .models import Artifact, ChatSession, LLMProvider, Message
from .security import decrypt_secret

MAX_LOOP = 8          # 工具循环轮数上限（成本护栏）
MAX_TOKENS = 64000    # 流式输出上限（SDK 建议：大 max_tokens 必须流式）
DEFAULT_TITLE = "新会话"

ROLE_PROMPT = """你是 CodeForge，一个专注于前端代码生成的 AI Agent，运行在浏览器里的代码工作台中。

工作方式：
- 用户用自然语言描述需求，你通过调用 write_file 工具生成或修改项目文件。
- 先用一两句话说明实现思路（中文），然后调用工具写文件，全部写完后简要总结用法。

项目结构要求（重要，保证工作台的实时预览可用）：
- 默认生成自包含的静态前端项目，文件平铺在根目录，index.html 为入口（必需）。
- 样式放 style.css（用 <link rel="stylesheet" href="style.css"> 引用），
  脚本放 main.js（用 <script src="main.js"></script> 引用，放在 </body> 之前）。
- 不使用构建工具与 import 语句；需要第三方库时用 CDN（如 https://cdn.jsdelivr.net）。
- 确实需要多文件时可用更多 .html/.js/.css 文件，但 index.html 必须可直接打开。

写文件规则：
- 每次 write_file 写入一个文件的完整内容，绝不省略代码或用注释占位。
- 修改需求时基于「当前项目文件清单」重写受影响的文件（完整内容）。
- 代码质量要求：语义化标签、响应式布局、适量中文注释。

当前项目文件清单会在下方单独给出；新会话为空。"""

TOOLS = [
    {
        "name": "write_file",
        "description": (
            "写入或覆盖项目中的一个文件。每次调用写入完整文件内容。"
            "静态前端项目的入口必须是 index.html；样式与脚本分别放 style.css / main.js。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对路径，如 index.html、style.css、main.js",
                },
                "content": {"type": "string", "description": "文件完整内容"},
            },
            "required": ["path", "content"],
        },
    }
]

EXT_LANG = {
    ".html": "markup", ".htm": "markup", ".xml": "markup", ".svg": "markup",
    ".css": "css",
    ".js": "javascript", ".mjs": "javascript", ".jsx": "jsx",
    ".ts": "typescript", ".tsx": "tsx",
    ".json": "json", ".py": "python", ".md": "markdown",
    ".yml": "yaml", ".yaml": "yaml", ".sh": "bash", ".sql": "sql",
}


def lang_of(path: str) -> str:
    dot = path.rfind(".")
    return EXT_LANG.get(path[dot:].lower(), "text") if dot != -1 else "text"


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def files_block(files: dict) -> str:
    if not files:
        return "当前项目文件清单：（空项目，这是用户的第一个需求）"
    lines = [
        f"- {path}（{meta['language']}，{len((meta.get('content') or '').splitlines())} 行）"
        for path, meta in sorted(files.items())
    ]
    return "当前项目文件清单：\n" + "\n".join(lines)


def sanitize_path(raw: str) -> str | None:
    """校验并规范化文件路径，防目录穿越。"""
    p = str(raw or "").strip().replace("\\", "/").lstrip("/")
    if not p or len(p) > 200 or ".." in p.split("/") or p.startswith("."):
        return None
    return p


def to_plain_messages(msgs: list) -> list:
    """把包含 SDK block 对象的消息列表转为可 JSON 落库的纯字典列表。"""
    out = []
    for m in msgs:
        content = m["content"]
        if isinstance(content, list):
            converted = [b if isinstance(b, dict) else b.to_dict() for b in content]
            out.append({"role": m["role"], "content": converted})
        else:
            out.append(m)
    return out


def _load_state(session_id: int):
    with SessionLocal() as db:
        sess = db.get(ChatSession, session_id)
        if sess is None:
            return None
        art = db.execute(select(Artifact).where(Artifact.session_id == session_id)).scalar_one_or_none()
        return {
            "title": sess.title,
            "context": list(sess.context or []),
            "files": dict(art.files) if art else {},
        }


def resolve_provider(provider_id: int | None, model: str | None) -> dict | None:
    """选定模型服务：显式指定 > 默认服务 > 第一个启用项。

    在 Session 内取值转为纯 dict，避免 detached instance 访问问题。
    """
    with SessionLocal() as db:
        provs = db.execute(
            select(LLMProvider).where(LLMProvider.enabled).order_by(LLMProvider.id)
        ).scalars().all()
        if not provs:
            return None
        prov = next((p for p in provs if p.id == provider_id), None) if provider_id else None
        if prov is None:
            prov = next((p for p in provs if p.is_default), provs[0])
        models = list(prov.models or [])
        chosen = model if model and model in models else (models[0] if models else None)
        return {
            "name": prov.name,
            "api_key_enc": prov.api_key_enc,
            "base_url": prov.base_url,
            "use_thinking": bool(prov.use_thinking),
            "max_tokens": prov.max_tokens or MAX_TOKENS,
            "model": chosen,
        }


async def chat_sse(session_id: int, content: str, provider_id: int | None = None, model: str | None = None):
    """主入口：async 生成器，产出 SSE 文本。"""
    state = _load_state(session_id)
    if state is None:
        yield sse("error", {"message": "会话不存在"})
        return

    prov = resolve_provider(provider_id, model)
    if prov is None:
        yield sse("error", {"message": "未配置可用的模型服务，请联系管理员在「模型设置」中添加"})
        return
    if not prov["model"]:
        yield sse("error", {"message": f"模型服务「{prov['name']}」未配置任何模型 ID"})
        return
    client = build_client(decrypt_secret(prov["api_key_enc"]), prov["base_url"])

    # 1) 持久化用户消息 + 更新会话标题
    with SessionLocal() as db:
        sess = db.get(ChatSession, session_id)
        db.add(Message(session_id=session_id, role="user", content=content))
        sess.context = list(sess.context or []) + [{"role": "user", "content": content}]
        if sess.title == DEFAULT_TITLE:
            sess.title = content[:24].strip() or DEFAULT_TITLE
        sess.updated_at = datetime.now(timezone.utc)
        db.commit()
        messages: list = list(sess.context)

    model = prov["model"]

    assistant_text: list[str] = []
    tool_events: list[dict] = []
    usage_total = {"input_tokens": 0, "output_tokens": 0}
    files = state["files"]
    system = [
        {"type": "text", "text": ROLE_PROMPT, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": files_block(files)},
    ]
    # 个别 Anthropic 兼容端点不支持 thinking 参数，按服务开关
    extra_kwargs: dict = {}
    if prov["use_thinking"]:
        extra_kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}

    yield sse("status", {"stage": "generating", "model": model, "provider": prov["name"]})

    try:
        # 2) Agent 工具循环
        for _round in range(MAX_LOOP):
            async with client.messages.stream(
                model=model,
                max_tokens=prov["max_tokens"],
                system=system,
                tools=TOOLS,
                messages=messages,
                **extra_kwargs,
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_start":
                        btype = event.content_block.type
                        if btype == "thinking":
                            yield sse("status", {"stage": "thinking"})
                        elif btype == "tool_use":
                            yield sse("status", {"stage": "tool"})
                    elif event.type == "content_block_delta":
                        d = event.delta
                        if d.type == "text_delta":
                            assistant_text.append(d.text)
                            yield sse("text_delta", {"delta": d.text})
                        elif d.type == "thinking_delta":
                            yield sse("thinking_delta", {"delta": d.thinking})
                final = await stream.get_final_message()

            usage_total["input_tokens"] += final.usage.input_tokens or 0
            usage_total["output_tokens"] += final.usage.output_tokens or 0

            # 回填 assistant 原始 content（含 thinking / tool_use 块，保真回放）
            messages.append({"role": "assistant", "content": final.content})

            if final.stop_reason != "tool_use":
                break

            # 3) 执行工具（write_file）并回填结果
            tool_results = []
            for block in final.content:
                if block.type != "tool_use":
                    continue
                raw_input = block.input or {}
                path = sanitize_path(raw_input.get("path", ""))
                text = str(raw_input.get("content", ""))
                yield sse(
                    "tool_call",
                    {"id": block.id, "name": block.name, "path": path, "bytes": len(text)},
                )
                if block.name != "write_file" or path is None:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "is_error": True,
                        "content": "非法的文件路径或工具名，请用 write_file 写入根目录下的合法路径。",
                    })
                    continue

                with SessionLocal() as db:
                    art = db.execute(
                        select(Artifact).where(Artifact.session_id == session_id)
                    ).scalar_one_or_none()
                    if art is None:
                        art = Artifact(session_id=session_id, files={}, version=0)
                        db.add(art)
                    art.files = {**dict(art.files or {}), path: {"content": text, "language": lang_of(path)}}
                    art.version = (art.version or 0) + 1
                    art.updated_at = datetime.now(timezone.utc)
                    db.commit()
                    version, files = art.version, dict(art.files)

                tool_events.append({"name": "write_file", "path": path, "version": version})
                yield sse("artifact_updated", {"version": version, "changed": path, "files": sorted(files.keys())})
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"已写入 {path}（{len(text.splitlines())} 行），项目当前版本 v{version}。",
                })

            messages.append({"role": "user", "content": tool_results})
            # 文件清单变了：只更新缓存断点之后的动态块，前缀缓存不受影响
            system[1] = {"type": "text", "text": files_block(files)}
        else:
            assistant_text.append("\n\n（已达到单轮工具调用上限，可继续对话让我完成剩余部分。）")

        # 4) 持久化 assistant 消息与完整上下文
        with SessionLocal() as db:
            sess = db.get(ChatSession, session_id)
            db.add(Message(
                session_id=session_id,
                role="assistant",
                content="".join(assistant_text).strip(),
                tool_events=tool_events,
            ))
            sess.context = to_plain_messages(messages)
            sess.updated_at = datetime.now(timezone.utc)
            db.commit()

        yield sse("done", {"usage": usage_total, "files": sorted(files.keys())})

    except anthropic.AuthenticationError:
        yield sse("error", {"message": "API Key 无效或未授权，请联系管理员在「模型设置」中更新"})
    except anthropic.RateLimitError:
        yield sse("error", {"message": "已触发模型限流，请稍后重试"})
    except anthropic.APIConnectionError:
        yield sse("error", {"message": "无法连接 Claude API，请检查网络或 Base URL 配置"})
    except anthropic.APIStatusError as e:
        yield sse("error", {"message": f"模型服务错误 {e.status_code}：{e.message}"})
    except anthropic.APIError as e:
        yield sse("error", {"message": f"模型调用失败：{str(e)[:300]}"})
