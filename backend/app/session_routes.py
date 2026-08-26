"""会话与消息：CRUD、工件查询、SSE 聊天端点。"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as OrmSession

from .agent import chat_sse
from .deps import get_current_user, get_db, get_owned_session
from .models import Artifact, ChatSession, LLMProvider, Message, User
from .schemas import (
    ArtifactOut,
    ChatIn,
    MessageOut,
    SessionCreate,
    SessionDetailOut,
    SessionOut,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _iso(dt) -> str:
    return dt.isoformat() if dt else ""


def _session_out(sess: ChatSession) -> SessionOut:
    return SessionOut(
        id=sess.id, title=sess.title, created_at=_iso(sess.created_at), updated_at=_iso(sess.updated_at)
    )


@router.get("", response_model=list[SessionOut])
def list_sessions(user: User = Depends(get_current_user), db: OrmSession = Depends(get_db)):
    rows = db.execute(
        select(ChatSession)
        .where(ChatSession.user_id == user.id)
        .order_by(ChatSession.updated_at.desc())
    ).scalars().all()
    return [_session_out(s) for s in rows]


@router.post("", response_model=SessionOut)
def create_session(
    body: SessionCreate, user: User = Depends(get_current_user), db: OrmSession = Depends(get_db)
):
    sess = ChatSession(user_id=user.id, title=(body.title or "新会话").strip() or "新会话")
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return _session_out(sess)


@router.get("/{session_id}", response_model=SessionDetailOut)
def get_session(sess: ChatSession = Depends(get_owned_session), db: OrmSession = Depends(get_db)):
    msgs = db.execute(
        select(Message).where(Message.session_id == sess.id).order_by(Message.id.asc())
    ).scalars().all()
    return SessionDetailOut(
        id=sess.id,
        title=sess.title,
        created_at=_iso(sess.created_at),
        updated_at=_iso(sess.updated_at),
        messages=[
            MessageOut(
                id=m.id, role=m.role, content=m.content, tool_events=m.tool_events or [], created_at=_iso(m.created_at)
            )
            for m in msgs
        ],
    )


@router.delete("/{session_id}", status_code=204)
def delete_session(sess: ChatSession = Depends(get_owned_session), db: OrmSession = Depends(get_db)):
    db.execute(delete(Message).where(Message.session_id == sess.id))
    db.execute(delete(Artifact).where(Artifact.session_id == sess.id))
    db.delete(sess)
    db.commit()


@router.get("/{session_id}/artifact", response_model=ArtifactOut)
def get_artifact(sess: ChatSession = Depends(get_owned_session), db: OrmSession = Depends(get_db)):
    art = db.execute(select(Artifact).where(Artifact.session_id == sess.id)).scalar_one_or_none()
    if art is None:
        return ArtifactOut(version=0, files={})
    return ArtifactOut(version=art.version or 0, files=art.files or {})


@router.post("/{session_id}/chat")
def chat(
    body: ChatIn,
    sess: ChatSession = Depends(get_owned_session),
    db: OrmSession = Depends(get_db),
):
    has_provider = db.execute(
        select(LLMProvider.id).where(LLMProvider.enabled).limit(1)
    ).scalar_one_or_none()
    if has_provider is None:
        raise HTTPException(status_code=403, detail="未配置可用的模型服务，请联系管理员在「模型设置」中添加")

    return StreamingResponse(
        chat_sse(sess.id, body.content, body.provider_id, body.model),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
