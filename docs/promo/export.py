"""Serves the promo page and turns what it renders into an MP4.

    python3 docs/promo/export.py
    open http://127.0.0.1:8765/docs/promo/   then click 导出视频

The page PUTs the soundtrack (WAV) and every frame (JPEG); POST /encode runs
encode.swift (AVFoundation) and writes docs/promo/claudemom-promo.mp4.
"""
import http.server
import pathlib
import re
import shutil
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
WORK = pathlib.Path(tempfile.gettempdir()) / 'claudemom-promo'
FRAMES = WORK / 'frames'
OUT = HERE / 'claudemom-promo.mp4'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def reply(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        m = re.fullmatch(r'/frames/(\d{5})\.jpg', self.path)
        if m:
            dest = FRAMES / f'{m.group(1)}.jpg'
        elif self.path == '/audio.wav':
            dest = WORK / 'audio.wav'
        else:
            return self.reply(404, 'unknown path')
        dest.write_bytes(self.rfile.read(int(self.headers['Content-Length'])))
        self.reply(200, 'ok')

    def do_POST(self):
        if self.path == '/begin':
            shutil.rmtree(WORK, ignore_errors=True)
            FRAMES.mkdir(parents=True)
            return self.reply(200, 'ok')
        if self.path == '/encode':
            r = subprocess.run(['swift', str(HERE / 'encode.swift'), str(FRAMES), str(WORK / 'audio.wav'), str(OUT)],
                               capture_output=True, text=True)
            if r.returncode:
                return self.reply(500, r.stderr[-2000:])
            shutil.rmtree(WORK, ignore_errors=True)
            return self.reply(200, r.stdout.strip())
        self.reply(404, 'unknown path')

    def log_message(self, *a):
        pass


print('http://127.0.0.1:8765/docs/promo/')
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
