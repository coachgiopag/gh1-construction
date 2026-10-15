"""Local dev server that disables caching, so browser tabs always see the latest saved files."""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Mirror Cloudflare Pages: /about serves about.html
        translated = super().translate_path(path)
        if not os.path.exists(translated) and os.path.exists(translated + ".html"):
            return translated + ".html"
        return translated

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    http.server.test(HandlerClass=NoCacheHandler, port=port)
