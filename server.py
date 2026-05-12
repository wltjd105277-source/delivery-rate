"""쿠팡 납품률 · 미출고 관리 사이트 — FastAPI 백엔드.

- 정적 파일(index.html, app.js, sku_lookup.json) 서빙
- /api/data GET/PUT — 데이터 영구 저장 (PC 간 공유 핵심)
- /api/health
- 저장소 선택 자동:
    1) DATABASE_URL 환경변수 있으면 → PostgreSQL (권장: Render Postgres)
    2) 아니면 → 디스크 JSON 파일 (Render Disk 또는 로컬)
- 선택적 ACCESS_TOKEN 환경변수로 인증 (헤더 x-token)

로컬 실행: python server.py  →  http://localhost:8080
Render 배포: render.yaml의 buildCommand/startCommand 사용
"""
import os
import json
from pathlib import Path

from fastapi import FastAPI, Body, HTTPException, Request, Depends
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="쿠팡 미출고 관리")
ROOT = Path(__file__).parent.resolve()

# ─────────────────────────────────────────────────────────────
# 저장소 초기화
# ─────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()

_pg_pool = None  # psycopg ConnectionPool (Postgres 모드일 때만)

if DATABASE_URL:
    # Render의 DATABASE_URL은 'postgres://'로 시작하는 경우가 있는데 psycopg는 'postgresql://'를 기대
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]
    try:
        from psycopg_pool import ConnectionPool

        _pg_pool = ConnectionPool(
            DATABASE_URL,
            min_size=1,
            max_size=5,
            kwargs={"sslmode": "require"},
            open=True,
        )
        # 스키마 초기화 (key-value 형태)
        with _pg_pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_kv (
                      key TEXT PRIMARY KEY,
                      value JSONB NOT NULL,
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            conn.commit()
        print("[STORAGE] PostgreSQL 사용 중")
    except Exception as e:
        print(f"[STORAGE] Postgres 연결 실패, 디스크 fallback: {e}")
        _pg_pool = None

# 디스크 fallback 경로
_data_dir_env = os.environ.get("DATA_DIR")
if _data_dir_env:
    DATA_DIR = Path(_data_dir_env)
elif Path("/data").exists() and os.access("/data", os.W_OK):
    DATA_DIR = Path("/data")
else:
    DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_PATH = DATA_DIR / "data.json"

if _pg_pool is None:
    print(f"[STORAGE] 디스크 JSON 사용: {DATA_PATH}")


def _load_data() -> dict:
    if _pg_pool:
        try:
            with _pg_pool.connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT value FROM app_kv WHERE key=%s", ("main",))
                row = 