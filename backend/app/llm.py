"""LLM 客户端工厂与连通性测试（Anthropic 官方 SDK）。"""
import anthropic

from .models import SystemConfig
from .security import decrypt_secret


def client_from_config(cfg: SystemConfig) -> anthropic.AsyncAnthropic:
    if not cfg.llm_api_key_enc:
        raise RuntimeError("系统未配置 API Key")
    return build_client(decrypt_secret(cfg.llm_api_key_enc), cfg.llm_base_url)


def build_client(api_key: str, base_url: str | None = None) -> anthropic.AsyncAnthropic:
    kwargs: dict = {"api_key": api_key, "timeout": 300.0}
    if base_url:
        kwargs["base_url"] = base_url.rstrip("/")
    return anthropic.AsyncAnthropic(**kwargs)


async def test_connection(api_key: str, base_url: str | None, model: str) -> dict:
    """用请求体中的 Key 发一条最小请求验证连通性，不落库。"""
    try:
        client = build_client(api_key, base_url)
        resp = await client.messages.create(
            model=model,
            max_tokens=32,
            messages=[{"role": "user", "content": "请只回复两个字：正常"}],
        )
        reply = "".join(b.text for b in resp.content if b.type == "text")
        return {"ok": True, "detail": f"连接成功（模型 {resp.model}）", "reply": reply[:80]}
    except anthropic.AuthenticationError:
        return {"ok": False, "detail": "API Key 无效或未授权"}
    except anthropic.NotFoundError:
        return {"ok": False, "detail": f"模型不存在：{model}"}
    except anthropic.APIConnectionError:
        return {"ok": False, "detail": "无法连接 API，请检查网络或 Base URL"}
    except anthropic.RateLimitError:
        return {"ok": False, "detail": "已触发限流（Key 本身有效），请稍后重试"}
    except anthropic.APIStatusError as e:
        return {"ok": False, "detail": f"API 错误 {e.status_code}：{e.message}"}
    except anthropic.APIError as e:
        return {"ok": False, "detail": f"API 错误：{str(e)[:200]}"}
