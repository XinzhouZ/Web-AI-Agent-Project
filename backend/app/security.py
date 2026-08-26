"""密码哈希、JWT、密钥加密。"""
import base64
import hashlib
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.fernet import Fernet

from .config import settings


# ---------- 密码 ----------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode())
    except ValueError:
        return False


def validate_password_strength(password: str) -> str | None:
    """返回错误信息；合法返回 None。规则：>=8 位且同时含字母与数字。"""
    if len(password) < 8:
        return "密码长度至少 8 位"
    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        return "密码需同时包含字母与数字"
    return None


# ---------- JWT ----------
def create_token(user_id: int, token_type: str) -> str:
    delta = (
        timedelta(minutes=settings.access_token_minutes)
        if token_type == "access"
        else timedelta(days=settings.refresh_token_days)
    )
    payload = {
        "sub": str(user_id),
        "type": token_type,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + delta,
    }
    return jwt.encode(payload, settings.server_secret, algorithm="HS256")


def decode_token(token: str, expected_type: str) -> int:
    payload = jwt.decode(token, settings.server_secret, algorithms=["HS256"])
    if payload.get("type") != expected_type:
        raise jwt.InvalidTokenError("token 类型不符")
    return int(payload["sub"])


# ---------- 密钥加密（API Key 落库） ----------
def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.server_secret.encode()).digest())
    return Fernet(key)


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt_secret(cipher: str) -> str:
    return _fernet().decrypt(cipher.encode()).decode()
