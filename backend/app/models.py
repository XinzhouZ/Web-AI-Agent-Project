"""ORM 模型。"""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="user")  # admin | user
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SystemConfig(Base):
    """系统配置单例（id 恒为 1）。"""

    __tablename__ = "system_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    initialized: Mapped[bool] = mapped_column(Boolean, default=False)
    admin_username: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # API Key 密文落库（Fernet/AES，密钥由 SERVER_SECRET 派生）
    llm_api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    llm_model: Mapped[str] = mapped_column(String(100), default="claude-opus-5")
    allow_registration: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class LLMProvider(Base):
    """模型服务接入点：Anthropic 官方 / 智谱 GLM / 任意 Anthropic 兼容网关。

    SystemConfig.llm_* 仅保留初始化时的首份配置做迁移种子，
    运行期以本表为准，支持同时接入多个服务、每服务独立 Key 与模型列表。
    """

    __tablename__ = "llm_providers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    # API Key 密文落库（Fernet/AES，密钥由 SERVER_SECRET 派生）
    api_key_enc: Mapped[str] = mapped_column(Text)
    # Anthropic 兼容端点；None = 官方 api.anthropic.com
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    models: Mapped[list] = mapped_column(JSON, default=list)  # 可用模型 ID 列表
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    # 请求是否携带 thinking 参数（个别兼容端点不支持时可关闭）
    use_thinking: Mapped[bool] = mapped_column(Boolean, default=True)
    max_tokens: Mapped[int] = mapped_column(Integer, default=64000)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ChatSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(200), default="新会话")
    # 持久化原始 API message 列表（含 tool_use / tool_result 块），保证多轮工具调用保真回放
    context: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="")
    tool_events: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Artifact(Base):
    """每个会话一份工件：多文件 + 版本计数。"""

    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), unique=True, index=True)
    files: Mapped[dict] = mapped_column(JSON, default=dict)  # {path: {content, language}}
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
