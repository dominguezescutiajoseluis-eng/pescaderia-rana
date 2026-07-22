import http.server
import socketserver
import socket
import os
import sys

# Obtener puerto desde la variable de entorno de Render (PORT) o 8000 por defecto
PORT = int(os.environ.get('PORT', 8000))

class CustomHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Evitar caché en desarrollo pero permitir soporte PWA y HTTPS
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def guess_type(self, path):
        # Asegurar MIME types correctos para PWA
        if path.endswith('.webmanifest') or path.endswith('manifest.json'):
            return 'application/manifest+json'
        if path.endswith('.js'):
            return 'application/javascript'
        return super().guess_type(path)

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

if __name__ == '__main__':
    local_ip = get_local_ip()
    print("=" * 60)
    print("      PESCADERÍA RANA - SERVIDOR EN EJECUCIÓN")
    print("=" * 60)
    print(f" Puerto configurado: {PORT}")
    print(f" PC Local:          http://localhost:{PORT}")
    print(f" Teléfono Móvil:    http://{local_ip}:{PORT}")
    print("=" * 60)
    
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("0.0.0.0", PORT), CustomHTTPRequestHandler) as httpd:
            httpd.serve_forever()
    except Exception as e:
        print(f"Error al iniciar en puerto {PORT}: {e}")
        sys.exit(1)
