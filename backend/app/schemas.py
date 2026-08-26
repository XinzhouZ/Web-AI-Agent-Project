"""Pydantic 请求/响应模型。"""
import re

from pydantic import BaseModel, Field, field_validator

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,50}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    role: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------- 认证 ----------
class RegisterIn(BaseModel):
    username: str
    email: str
    password: str

    @field_validator("username")
    @classmethod
    def check_username(cls, v: str) -> str:
        if not USERNAME_RE.match(v):
            raise ValueError("用户名需为 3-50 位字母/数字/下划线")
        return v

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        if not EMAIL_RE.match(v):
            raise ValueError("邮箱格式不正确")
        return v.lower()


class LoginIn(BaseModel):
    username: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


# ---------- 系统初始化 ----------
class AdminIn(BaseModel):
    username: str
    email: str
    password: str


class LLMIn(BaseModel):
    api_key: str = Field(min_length=8)
    base_url: str | None = None
    model: str = "claude-opus-5"


class TestLLMIn(LLMIn):
    """测试连接：Key 只在请求体中流转，不落库。"""


class InitIn(BaseModel):
    admin: AdminIn
    llm: LLMIn
    allow_registration: bool = True


# ---------- 模型服务（多 Provider） ----------
class ProviderIn(BaseModel):
    """新增/更新模型服务；更新时 api_key 留空表示沿用现有 Key。"""
    name: str = Field(min_length=1, max_length=100)
    api_key: str | None = Field(default=None, min_length=8)
    base_url: str | None = None        # None/空 = 官方地址；更新时 None 表示不修改
    models: list[str] = Field(min_length=1)
    enabled: bool = True
    is_default: bool = False
    use_thinking: bool = True
    max_tokens: int = Field(default=64000, ge=1024, le=200000)

    @field_validator("models")
    @classmethod
    def clean_models(cls, v: list[str]) -> list[str]:
        ms = [m.strip() for m in v if m and m.strip()]
        if not ms:
            raise ValueError("至少配置一个模型 ID")
        return ms


# ---------- 会话 ----------
class SessionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)


class SessionOut(BaseModel):
    id: int
    title: str
    created_at: str
    updated_at: str


class MessageOut(BaseModel):
    id: int
    role: str
    content: str
    tool_events: list
    created_at: str


class SessionDetailOut(BaseModel):
    id: int
    title: str
    created_at: str
    updated_at: str
    messages: list[MessageOut]


class ArtifactOut(BaseModel):
    version: int
    files: dict


class ChatIn(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    # 可选：指定模型服务与模型；缺省用默认服务
    provider_id: int | None = None
    model: str | None = None
