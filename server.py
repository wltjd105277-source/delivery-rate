"""로컬에서 사이트를 띄울 때 쓰는 초간단 서버.
배포는 render.yaml(Static Site)로 하면 이 파일은 필요 없습니다.
실행: python server.py  →  http://localhost:8080
"""
import http.server, socketserver, os, sys

PORT = int(os.environ.get("PORT", 8080))
DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(DIR)

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"  → http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n종료")
            sys.exit(0)
