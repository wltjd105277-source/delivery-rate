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
                row = cur.fetchone()
            if row:
                return row[0] if isinstance(row[0], dict) else json.loads(row[0])
            return {"rows": [], "files": []}
        except Exception as e:
            print(f"[LOAD] PG 오류 → 디스크 fallback: {e}")
    if not DATA_PATH.exists():
        return {"rows": [], "files": []}
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def _save_data(payload: dict) -> int:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if _pg_pool:
        try:
            with _pg_pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO app_kv (key, value, updated_at)
                    VALUES (%s, %s::jsonb, NOW())
                    ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, updated_at = NOW()
                    """,
                    ("main", body),
                )
                conn.commit()
            return len(body)
        except Exception as e:
            print(f"[SAVE] PG 오류 → 디스크 fallback: {e}")
    # 디스크 저장
    if DATA_PATH.exists():
        try:
            (DATA_DIR / "data.json.bak").write_bytes(DATA_PATH.read_bytes())
        except Exception:
            pass
    DATA_PATH.write_text(body, encoding="utf-8")
    return DATA_PATH.stat().st_size


# ─────────────────────────────────────────────────────────────
# 인증
# ─────────────────────────────────────────────────────────────
def check_auth(request: Request):
    if not ACCESS_TOKEN:
        return  # 인증 비활성 (URL이 비밀번호 역할)
    token = (
        request.headers.get("x-token")
        or request.headers.get("X-Token")
        or request.query_params.get("token")
        or ""
    )
    if token != ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─────────────────────────────────────────────────────────────
# API
# ─────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {
        "ok": True,
        "storage": "postgres" if _pg_pool else "disk",
        "data_dir": str(DATA_DIR) if not _pg_pool else None,
        "auth_enabled": bool(ACCESS_TOKEN),
    }


@app.get("/api/data")
def get_data(_=Depends(check_auth)):
    return _load_data()


@app.put("/api/data")
async def save_data(request: Request, payload: dict = Body(...)):
    check_auth(request)
    size = _save_data(payload)
    return {"ok": True, "size": size}


# ─────────────────────────────────────────────────────────────
# 정적 파일 서빙
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return FileResponse(
        ROOT / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


app.mount("/", StaticFiles(directory=str(ROOT), html=False), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    print(f"  AUTH = {'ENABLED' if ACCESS_TOKEN else 'DISABLED (URL이 비밀번호 역할)'}")
    uvicorn.run(app, host="0.0.0.0", port=port)
