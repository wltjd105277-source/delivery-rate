"""쿠팡 납품률 · 미출고 관리 사이트 — FastAPI 백엔드.

- 정적 파일(index.html, app.js, sku_lookup.json) 서빙
- /api/data GET/PUT — JSON 데이터를 디스크에 영구 저장 (PC 간 공유 핵심)
- /api/health
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

# Render Disk 마운트 경로 (기본 /data). 로컬 개발 시는 ./data 폴더로 자동 fallback.
_data_dir_env = os.environ.get("DATA_DIR")
if _data_dir_env:
    DATA_DIR = Path(_data_dir_env)
elif Path("/data").exists() and os.access("/data", os.W_OK):
    DATA_DIR = Path("/data")
else:
    DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_PATH = DATA_DIR / "data.json"

# 선택적 인증
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()


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


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "data_dir": str(DATA_DIR),
        "data_exists": DATA_PATH.exists(),
        "data_size": DATA_PATH.stat().st_size if DATA_PATH.exists() else 0,
        "auth_enabled": bool(ACCESS_TOKEN),
    }


@app.get("/api/data")
def get_data(_=Depends(check_auth)):
    if not DATA_PATH.exists():
        return {"rows": [], "files": []}
    try:
        return json.loads(DATA_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        return JSONResponse({"rows": [], "files": [], "_error": str(e)}, status_code=200)


@app.put("/api/data")
async def save_data(request: Request, payload: dict = Body(...)):
    check_auth(request)
    # 백업: 이전 파일을 .bak로 옮긴 후 새로 저장
    if DATA_PATH.exists():
        try:
            (DATA_DIR / "data.json.bak").write_bytes(DATA_PATH.read_bytes())
        except Exception:
            pass
    DATA_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return {"ok": True, "size": DATA_PATH.stat().st_size}


# 루트는 index.html
@app.get("/")
def root():
    return FileResponse(ROOT / "index.html")


# 정적 파일 (index.html, app.js, sku_lookup.json, css 등)
app.mount("/", StaticFiles(directory=str(ROOT), html=False), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    print(f"  → http://localhost:{port}")
    print(f"  DATA_DIR = {DATA_DIR}")
    print(f"  AUTH = {'ENABLED' if ACCESS_TOKEN else 'DISABLED (URL이 비밀번호 역할)'}")
    uvicorn.run(app, host="0.0.0.0", port=port)
