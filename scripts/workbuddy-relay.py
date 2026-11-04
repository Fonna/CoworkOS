"""Development-only loopback relay using an existing local OnIt WorkBuddy adapter.

Run with the Python environment that already provides OnIt and httpx. This does
not copy WorkBuddy credentials or implement a product provider/login flow.
"""

import argparse
import importlib
import json
import os
from pathlib import Path
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter-root", required=True, type=Path)
    parser.add_argument("--info-file", required=True, type=Path)
    parser.add_argument("--port", default=0, type=int)
    parser.add_argument("--model", default="glm-5.3-flash")
    options = parser.parse_args()
    sys.path.insert(0, str(options.adapter_root.resolve()))
    adapter_module = importlib.import_module("onit.workbuddy")
    httpx = importlib.import_module("httpx")
    adapter = adapter_module.WorkBuddyClient()
    token = secrets.token_hex(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log prompts, authorization headers or upstream errors.

        def authorized(self):
            provided = self.headers.get("Authorization", "")
            if not secrets.compare_digest(provided, "Bearer " + token):
                self.send_error(401, "Local relay authorization required")
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path not in ("/models", "/v1/models"):
                self.send_error(404)
                return
            body = json.dumps({"object": "list", "data": [{"id": options.model, "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not self.authorized():
                return
            if self.path not in ("/chat/completions", "/v1/chat/completions"):
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4 * 1024 * 1024:
                    self.send_error(413, "Request body size is invalid")
                    return
                self.connection.settimeout(15)
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
                    raise ValueError("Invalid chat request")
                if body.get("model") != options.model:
                    raise ValueError("Model does not match relay configuration")
            except (ValueError, OSError):
                self.send_error(400, "Invalid chat request")
                return
            started = False
            try:
                credential = adapter.credential()
                headers = adapter._headers(credential, chat=True)
                headers["Authorization"] = "Bearer " + credential["accessToken"]
                with httpx.Client(timeout=httpx.Timeout(120, connect=15), follow_redirects=False) as client:
                    with client.stream(
                        "POST", adapter_module.BASE + "/v2/chat/completions", headers=headers, json=body
                    ) as upstream:
                        if upstream.status_code != 200:
                            self.send_error(502, "WorkBuddy request failed")
                            return
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
                        self.send_header("Connection", "close")
                        self.end_headers()
                        started = True
                        for chunk in upstream.iter_bytes():
                            self.wfile.write(chunk)
                            self.wfile.flush()
            except Exception:
                if not started:
                    self.send_error(502, "WorkBuddy connection failed")
            finally:
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", options.port), Handler)
    try:
        options.info_file.parent.mkdir(parents=True, exist_ok=True)
        # This is only a random loopback token; upstream credentials stay in memory.
        descriptor = os.open(options.info_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump({"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "apiKey": token, "model": options.model}, output)
        print(f"WorkBuddy relay ready; local connection settings: {options.info_file.resolve()}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
