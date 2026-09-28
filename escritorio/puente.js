/**
 * Pescadería Rana — PUENTE MÓVIL (cámara del móvil → OCR del ordenador)
 *
 * El Facturador de escritorio muestra un código QR; al abrirlo con la cámara
 * del móvil se abre ESTA página (servida por el propio PC a través del WiFi de
 * casa) y la foto de la papeleta viaja al ordenador, que la pasa por el OCR y
 * rellena el nº de lote. Sin cuentas, sin internet, sin cables.
 *
 * Seguridad razonable para una red doméstica:
 *  - Escucha solo en la interfaz local (0.0.0.0 es necesario para el móvil,
 *    pero la URL lleva un token aleatorio de 8 caracteres que cambia en cada
 *    sesión: sin él no se puede ver la página ni mandar fotos).
 *  - La sesión del puente muere sola tras 15 minutos.
 *  - Solo acepta POST /foto con token válido y JPEG de hasta ~12 MB.
 */

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_FOTO_BYTES = 12 * 1024 * 1024;
const VIDA_SESION_MS = 15 * 60 * 1000;

/** IPs IPv4 privadas de este equipo (las que puede usar el móvil) */
function ipsLocales() {
  const res = [];
  const ifaces = os.networkInterfaces();
  for (const nombre of Object.keys(ifaces)) {
    for (const it of ifaces[nombre] || []) {
      if (it.family === 'IPv4' && !it.internal) res.push(it.address);
    }
  }
  return res;
}

function paginaMovil(token, origen) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pescadería Rana — Foto de la papeleta</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0b4a6f; color: #eaf4f8;
         margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .caja { background: #0d5c75; border-radius: 16px; padding: 22px 20px; width: min(440px, 92vw);
          box-shadow: 0 10px 30px rgba(0,0,0,.35); text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 6px; }
  p { font-size: .92rem; line-height: 1.45; margin: 8px 0 14px; color: #cfe6ee; }
  #preview { width: 100%; max-height: 260px; object-fit: contain; border-radius: 10px;
             background: #093a4f; display: none; margin-bottom: 12px; }
  input[type=file] { display: none; }
  .btn { display: block; width: 100%; border: 0; border-radius: 12px; padding: 15px 14px;
         font-size: 1.05rem; font-weight: 700; margin-top: 10px; cursor: pointer; }
  .principal { background: #ffb703; color: #22303a; }
  .principal:disabled { opacity: .6; }
  .estado { min-height: 1.2em; font-size: .9rem; margin-top: 10px; color: #ffd97a; }
  .ok { color: #8ef0b2; }
</style>
</head>
<body>
<div class="caja">
  <h1>🐟 Pescadería Rana</h1>
  <p>Haz una foto de la <b>papeleta con el nº de lote</b> (o elígela de la galería).
     Se enviará al ordenador y se leerá allí automáticamente.</p>
  <img id="preview" alt="">
  <button class="btn principal" id="btn">📷 Hacer la foto</button>
  <button class="btn" style="background:#0b4a6f;color:#eaf4f8" id="btnGaleria">🖼️ Elegir de la galería</button>
  <input type="file" id="foto" accept="image/*" capture="environment">
  <input type="file" id="galeria" accept="image/*">
  <div class="estado" id="estado"></div>
</div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const ORIGEN = ${JSON.stringify(origen)};
  const btn = document.getElementById('btn');
  const btnGaleria = document.getElementById('btnGaleria');
  const input = document.getElementById('foto');
  const inputGaleria = document.getElementById('galeria');
  const estado = document.getElementById('estado');
  const preview = document.getElementById('preview');

  btn.addEventListener('click', () => input.click());
  btnGaleria.addEventListener('click', () => inputGaleria.click());

  async function enviar(file) {
    if (!file) return;
    estado.className = 'estado';
    estado.textContent = 'Enviando al ordenador…';
    btn.disabled = true;
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
    try {
      const datos = new FormData();
      datos.append('foto', file, 'papeleta.jpg');
      datos.append('token', TOKEN);
      const r = await fetch(ORIGEN + '/foto', { method: 'POST', body: datos });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        estado.className = 'estado ok';
        estado.textContent = '✅ ¡Enviado! Mira el ordenador.';
        setTimeout(() => location.reload(), 2500);
      } else {
        estado.className = 'estado';
        estado.textContent = 'No se pudo enviar: ' + (j.error || ('error ' + r.status));
      }
    } catch (err) {
      estado.textContent = 'Sin conexión con el ordenador: ¿estás en el mismo WiFi?';
    }
    btn.disabled = false;
  }
  input.addEventListener('change', e => enviar(e.target.files[0]));
  inputGaleria.addEventListener('change', e => enviar(e.target.files[0]));
</script>
</body>
</html>`;
}

/**
 * Arranca el puente. Devuelve una promesa con { url, ips, cerrar }.
 * `url` es la que debe ir DENTRO del código QR.
 */
function iniciarPuente(puertoBase = 8790) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(5).toString('hex'); // 10 caracteres
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://movil');
      res.setHeader('Cache-Control', 'no-store');

      if (url.pathname === '/' + token) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(paginaMovil(token, 'http://' + (req.headers.host || 'ordenador')));
      }
      if (url.pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/foto' && req.method === 'POST') {
        let tam = 0;
        const trozos = [];
        req.on('data', (t) => {
          tam += t.length;
          if (tam > MAX_FOTO_BYTES) {
            req.destroy();
            return;
          }
          trozos.push(t);
        });
        req.on('end', () => {
          try {
            const cuerpo = Buffer.concat(trozos);
            const texto = cuerpo.toString('latin1');
            // La parte de la foto: desde name="foto" hasta la línea en blanco
            // (puede haber varias cabeceras: Content-Disposition + Content-Type)
            const m = /\bname="foto"[\s\S]*?\r\n\r\n/.exec(texto);
            const tokenMatch = /\bname="token"\r\n\r\n([a-f0-9]+)/.exec(texto);
            if (!tokenMatch || tokenMatch[1] !== token) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'sesión no válida: vuelve a leer el QR' }));
            }
            if (!m) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'falta la foto' }));
            }
            const inicio = m.index + m[0].length;
            // El dato acaba en el primer \r\n-- (apertura del boundary de cierre)
            const fin = cuerpo.indexOf('\r\n--', inicio);
            let foto = cuerpo.subarray(inicio, fin > inicio ? fin : undefined);
            // quitar \r\n final del dato
            while (foto.length && (foto[foto.length - 1] === 13 || foto[foto.length - 1] === 10)) foto = foto.subarray(0, foto.length - 1);
            if (!foto.length || foto[0] !== 0xff || foto[1] !== 0xd8) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'la foto no es una imagen JPEG válida' }));
            }
            const dataUrl = 'data:image/jpeg;base64,' + foto.toString('base64');
            console.log('Puente: foto recibida del móvil (' + Math.round(foto.length / 1024) + ' KB)');
            process.emit('puente-foto', dataUrl);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'error interno' }));
          }
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No encontrado');
    });

    let intento = 0;
    const probar = () => {
      if (intento >= 8) return reject(new Error('Sin puerto libre para el puente del móvil'));
      const puerto = puertoBase + intento++;
      server.removeAllListeners('error');
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') probar();
        else reject(err);
      });
      server.listen(puerto, '0.0.0.0', () => {
        const ips = ipsLocales();
        const ip = ips[0];
        if (!ip) {
          server.close();
          return reject(new Error('Este equipo no está conectado a ninguna red (WiFi) — el móvil no podría llegar'));
        }
        const url = 'http://' + ip + ':' + puerto + '/' + token;
        console.log('Puente móvil listo en ' + url);
        resolve({
          url,
          ips,
          cerrar: () => { try { server.close(); } catch (e) { /* ya estaba */ } },
        });
      });
    };
    probar();
  });
}

module.exports = { iniciarPuente, VIDA_SESION_MS };
