"""系统初始化：状态查询 / 连通性测试 / 执行初始化 / 模型服务管理。"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from .deps import get_config, get_current_user, get_db, require_admin
from .llm import test_connection
from .models import LLMProvider, SystemConfig, User
from .schemas import InitIn, ProviderIn, TestLLMIn, TokenOut, UserOut
from .security import (
    create_token,
    decrypt_secret,
    encrypt_secret,
    hash_password,
    validate_password_strength,
)

router = APIRouter(prefix="/api/system", tags=["system"])


def _get_config(db: OrmSession) -> SystemConfig | None:
    return db.get(SystemConfig, 1)


@router.get("/status")
def system_status(db: OrmSession = Depends(get_db)):
    cfg = _get_config(db)
    return {
        "initialized": bool(cfg and cfg.initialized),
        "allow_registration": bool(cfg.allow_registration) if cfg else True,
    }


@router.post("/test-llm")
async def test_llm(body: TestLLMIn):
    """用请求体中的 Key 即时测试连通性（未初始化也可用，不落库）。"""
    return await test_connection(body.api_key.strip(), body.base_url, body.model)


# ---------- 模型服务管理（仅管理员） ----------
def _mask_key(enc: str | None) -> str:
    key = decrypt_secret(enc) if enc else ""
    return f"{key[:10]}…{key[-4:]}" if len(key) > 16 else "（Key 异常，请重新填写）"


def _provider_out(p: LLMProvider) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "base_url": p.base_url,
        "models": list(p.models or []),
        "enabled": bool(p.enabled),
        "is_default": bool(p.is_default),
        "use_thinking": bool(p.use_thinking),
        "max_tokens": p.max_tokens or 64000,
        "api_key_masked": _mask_key(p.api_key_enc),
    }


def _name_taken(db: OrmSession, name: str, exclude_id: int | None = None) -> bool:
    q = select(LLMProvider).where(LLMProvider.name == name)
    if exclude_id is not None:
        q = q.where(LLMProvider.id != exclude_id)
    return db.execute(q).scalar_one_or_none() is not None


@router.get("/providers")
def list_providers(user: User = Depends(require_admin), db: OrmSession = Depends(get_db)):
    rows = db.execute(select(LLMProvider).order_by(LLMProvider.id)).scalars().all()
    return [_provider_out(p) for p in rows]


@router.post("/providers")
def create_provider(body: ProviderIn, user: User = Depends(require_admin), db: OrmSession = Depends(get_db)):
    get_config(db)  # 系统必须已初始化
    if not (body.api_key and body.api_key.strip()):
        raise HTTPException(status_code=400, detail="新增模型服务必须填写 API Key")
    if _name_taken(db, body.name.strip()):
        raise HTTPException(status_code=400, detail="同名模型服务已存在")

    is_first = db.execute(select(LLMProvider.id).limit(1)).scalar_one_or_none() is None
    is_default = body.is_default or is_first  # 第一个服务强制为默认
    if is_default:
        for p in db.execute(select(LLMProvider)).scalars():
            p.is_default = False
    prov = LLMProvider(
        name=body.name.strip(),
        api_key_enc=encrypt_secret(body.api_key.strip()),
        base_url=(body.base_url or "").strip() or None,
        models=body.models,
        enabled=body.enabled,
        is_default=is_default,
        use_thinking=body.use_thinking,
        max_tokens=body.max_tokens,
    )
    db.add(prov)
    db.commit()
    db.refresh(prov)
    return _provider_out(prov)


@router.put("/providers/{provider_id}")
def update_provider(
    provider_id: int, body: ProviderIn, user: User = Depends(require_admin), db: OrmSession = Depends(get_db)
):
    prov = db.get(LLMProvider, provider_id)
    if prov is None:
        raise HTTPException(status_code=404, detail="模型服务不存在")
    name = body.name.strip()
    if name != prov.name and _name_taken(db, name, exclude_id=provider_id):
        raise HTTPException(status_code=400, detail="同名模型服务已存在")

    prov.name = name
    if body.api_key and body.api_key.strip():
        prov.api_key_enc = encrypt_secret(body.api_key.strip())
    if body.base_url is not None:
        prov.base_url = body.base_url.strip() or None
    prov.models = body.models
    prov.enabled = body.enabled
    prov.use_thinking = body.use_thinking
    prov.max_tokens = body.max_tokens
    if body.is_default and not prov.is_default:
        for p in db.execute(select(LLMProvider)).scalars():
            p.is_default = p.id == provider_id
    prov.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _provider_out(prov)


@router.delete("/providers/{provider_id}", status_code=204)
def delete_provider(provider_id: int, user: User = Depends(require_admin), db: OrmSession = Depends(get_db)):
    prov = db.get(LLMProvider, provider_id)
    if prov is None:
        raise HTTPException(status_code=404, detail="模型服务不存在")
    total = len(db.execute(select(LLMProvider.id)).scalars().all())
    if total <= 1:
        raise HTTPException(status_code=400, detail="至少保留一个模型服务")
    was_default = prov.is_default
    db.delete(prov)
    db.flush()
    if was_default:
        remain = db.execute(select(LLMProvider).order_by(LLMProvider.id)).scalars().first()
        if remain is not None:
            remain.is_default = True
    db.commit()


@router.post("/providers/{provider_id}/test")
async def test_provider(
    provider_id: int,
    model: str | None = None,
    user: User = Depends(require_admin),
    db: OrmSession = Depends(get_db),
):
    """实测已落库服务的连通性；model 缺省用该服务的第一个模型。"""
    prov = db.get(LLMProvider, provider_id)
    if prov is None:
        raise HTTPException(status_code=404, detail="模型服务不存在")
    m = (model or "").strip() or (prov.models or [""])[0]
    if not m:
        raise HTTPException(status_code=400, detail="该服务未配置模型，无法测试")
    return await test_connection(decrypt_secret(prov.api_key_enc), prov.base_url, m)


@router.get("/models")
def list_models(user: User = Depends(get_current_user), db: OrmSession = Depends(get_db)):
    """聊天侧模型选择器数据：全部启用服务下的所有模型（登录即可用）。"""
    out = []
    provs = db.execute(select(LLMProvider).where(LLMProvider.enabled).order_by(LLMProvider.id)).scalars().all()
    for p in provs:
        models = list(p.models or [])
        for i, m in enumerate(models):
            out.append({
                "provider_id": p.id,
                "provider": p.name,
                "model": m,
                "is_default": bool(p.is_default) and i == 0,
            })
    return out


@router.post("/init", response_model=TokenOut)
def system_init(body: InitIn, db: OrmSession = Depends(get_db)):
    cfg = _get_config(db)
    if cfg and cfg.initialized:
        raise HTTPException(status_code=403, detail="系统已初始化，禁止重复初始化")

    # 校验管理员账号
    if err := validate_password_strength(body.admin.password):
        raise HTTPException(status_code=400, detail=f"管理员密码不合规：{err}")
    if db.execute(select(User).where(User.username == body.admin.username)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="用户名已存在")
    email = body.admin.email.lower()
    if db.execute(select(User).where(User.email == email)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="邮箱已被使用")

    # 事务内：创建管理员 + 写配置单例
    admin = User(
        username=body.admin.username,
        email=email,
        password_hash=hash_password(body.admin.password),
        role="admin",
    )
    db.add(admin)
    db.flush()

    cfg = cfg or SystemConfig(id=1)
    cfg.initialized = True
    cfg.admin_username = body.admin.username
    cfg.llm_api_key_enc = encrypt_secret(body.llm.api_key.strip())
    cfg.llm_base_url = body.llm.base_url or None
    cfg.llm_model = body.llm.model
    cfg.allow_registration = body.allow_registration
    cfg.updated_at = datetime.now(timezone.utc)
    db.add(cfg)

    # 首个模型服务（运行期以 llm_providers 表为准；SystemConfig.llm_* 仅作迁移种子保留）
    base_url = (body.llm.base_url or "").strip() or None
    prov_name = "Anthropic 官方" if not base_url else base_url.split("//")[-1].split("/")[0]
    db.add(LLMProvider(
        name=prov_name,
        api_key_enc=cfg.llm_api_key_enc,
        base_url=base_url,
        models=[body.llm.model],
        is_default=True,
        use_thinking=True,
        max_tokens=64000,
    ))
    db.commit()
    db.refresh(admin)

    return TokenOut(
        access_token=create_token(admin.id, "access"),
        refresh_token=create_token(admin.id, "refresh"),
        user=UserOut(id=admin.id, username=admin.username, email=admin.email, role=admin.role),
    )
