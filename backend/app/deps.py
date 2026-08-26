"""FastAPI 依赖：DB 会话、当前用户、系统配置。"""
import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy import select

from .database import SessionLocal
from .models import ChatSession, SystemConfig, User
from .security import decode_token


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(request: Request, db: OrmSession = Depends(get_db)) -> User:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    try:
        user_id = decode_token(auth[7:], "access")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="无效的登录凭证")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def get_config(db: OrmSession = Depends(get_db)) -> SystemConfig:
    """确保系统已初始化并返回配置单例。"""
    cfg = db.get(SystemConfig, 1)
    if cfg is None or not cfg.initialized:
        raise HTTPException(status_code=403, detail="系统未初始化")
    return cfg


def get_owned_session(
    session_id: int,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
) -> ChatSession:
    sess = db.get(ChatSession, session_id)
    if sess is None or (sess.user_id != user.id and user.role != "admin"):
        # 404 而非 403，避免越权探测
        raise HTTPException(status_code=404, detail="会话不存在")
    return sess


def get_session_by_id(session_id: int, db: OrmSession) -> ChatSession | None:
    return db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    ).scalar_one_or_none()
