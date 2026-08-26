"""注册 / 登录 / 令牌刷新。"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from .deps import get_config, get_current_user, get_db
from .models import User
from .schemas import LoginIn, RefreshIn, RegisterIn, TokenOut, UserOut
from .security import create_token, decode_token, hash_password, validate_password_strength, verify_password
import jwt

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 登录失败锁定（原型：内存实现；生产换 Redis）
_LOGIN_FAILURES: dict[str, tuple[int, datetime | None]] = {}
MAX_FAILURES = 5
LOCK_MINUTES = 15


def _issue_tokens(user: User) -> TokenOut:
    return TokenOut(
        access_token=create_token(user.id, "access"),
        refresh_token=create_token(user.id, "refresh"),
        user=UserOut(id=user.id, username=user.username, email=user.email, role=user.role),
    )


@router.post("/register", response_model=TokenOut)
def register(body: RegisterIn, db: OrmSession = Depends(get_db)):
    cfg = get_config(db)  # 未初始化 → 403
    if not cfg.allow_registration:
        raise HTTPException(status_code=403, detail="当前系统已关闭注册")

    if err := validate_password_strength(body.password):
        raise HTTPException(status_code=400, detail=err)
    if db.execute(select(User).where(User.username == body.username)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="用户名已存在")
    if db.execute(select(User).where(User.email == body.email)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="邮箱已被注册")

    user = User(
        username=body.username,
        email=body.email,
        password_hash=hash_password(body.password),
        role="user",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue_tokens(user)


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: OrmSession = Depends(get_db)):
    get_config(db)  # 未初始化 → 403
    now = datetime.now(timezone.utc)
    record = _LOGIN_FAILURES.get(body.username)
    if record and record[1] and record[1] > now:
        wait = int((record[1] - now).total_seconds() // 60) + 1
        raise HTTPException(status_code=429, detail=f"失败次数过多，请 {wait} 分钟后再试")

    user = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        count = (record[0] + 1) if record else 1
        locked_until = (
            datetime.now(timezone.utc) + timedelta(minutes=LOCK_MINUTES)
            if count >= MAX_FAILURES else None
        )
        _LOGIN_FAILURES[body.username] = (count, locked_until)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    _LOGIN_FAILURES.pop(body.username, None)
    return _issue_tokens(user)


@router.post("/refresh", response_model=TokenOut)
def refresh(body: RefreshIn, db: OrmSession = Depends(get_db)):
    try:
        user_id = decode_token(body.refresh_token, "refresh")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="无效的刷新令牌")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    return _issue_tokens(user)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut(id=user.id, username=user.username, email=user.email, role=user.role)
