"""CodeForge 后端入口。"""
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from . import models  # noqa: F401  确保建表前模型已注册
from .auth_routes import router as auth_router
from .database import Base, SessionLocal, engine
from .models import LLMProvider, SystemConfig
from .session_routes import router as session_router
from .system_routes import router as system_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("codeforge")

app = FastAPI(title="CodeForge API", version="0.1.0", docs_url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    _seed_default_provider()
    logger.info("数据库已就绪：%s", engine.url)


def _seed_default_provider():
    """旧版单配置迁移：SystemConfig.llm_* → llm_providers 首行（幂等）。"""
    with SessionLocal() as db:
        if db.execute(select(LLMProvider.id).limit(1)).scalar_one_or_none() is not None:
            return
        cfg = db.get(SystemConfig, 1)
        if cfg is None or not cfg.initialized or not cfg.llm_api_key_enc:
            return
        name = "Anthropic 官方" if not cfg.llm_base_url else cfg.llm_base_url.split("//")[-1].split("/")[0]
        db.add(LLMProvider(
            name=name,
            api_key_enc=cfg.llm_api_key_enc,
            base_url=cfg.llm_base_url,
            models=[cfg.llm_model or "claude-opus-5"],
            is_default=True,
        ))
        db.commit()
        logger.info("已将系统 LLM 配置迁移为模型服务：%s", name)


@app.middleware("http")
async def init_guard(request: Request, call_next):
    """未初始化时，除 /api/system/* 与文档外的所有 API 一律 403。"""
    path = request.url.path
    if path.startswith("/api") and not path.startswith("/api/system"):
        with SessionLocal() as db:
            cfg = db.get(SystemConfig, 1)
            if cfg is None or not cfg.initialized:
                return JSONResponse({"detail": "系统未初始化，请先访问 /setup 完成初始化"}, status_code=403)
    return await call_next(request)


app.include_router(system_router)
app.include_router(auth_router)
app.include_router(session_router)


@app.get("/")
def root():
    return {"service": "CodeForge", "docs": "/docs", "status": "/api/system/status"}
