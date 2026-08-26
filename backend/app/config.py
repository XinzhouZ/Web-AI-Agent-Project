"""全局配置：从环境变量 / backend/.env 读取。"""
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class Settings:
    # 用于 JWT 签名 + Fernet 密钥派生，生产环境必须通过环境变量覆盖
    server_secret: str = os.getenv("SERVER_SECRET", "codeforge-dev-insecure-secret")
    database_url: str = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'codeforge.db'}")
    access_token_minutes: int = 30
    refresh_token_days: int = 7
    default_model: str = "claude-opus-5"


settings = Settings()

if settings.server_secret.startswith("codeforge-dev"):
    logging.getLogger("codeforge").warning(
        "SERVER_SECRET 使用了开发默认值，生产环境必须设置为长随机串！"
    )
