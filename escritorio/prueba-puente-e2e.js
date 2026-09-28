/**
 * Pescadería Rana — Facturador: autoprueba END-TO-END del PUENTE MÓVIL.
 * 1) Abre la app real, comprueba el botón 📱 y el QR en el modal
 * 2) Simula al móvil: descarga la página del puente y le manda una foto
 *    por HTTP (POST /foto) como lo haría el navegador del móvil
 * 3) La foto debe llegar a la ventana, pasar por el OCR y rellenar el lote
 *
 * Uso: node_modules/.bin/electron --user-data-dir=<carpeta> prueba-puente-e2e.js
 */

const { app } = require('electron');
const http = require('node:http');

require('./main.js');

let terminado = false;

const GUION_INICIAR = `(async () => {
  const esperar = ms => new Promise(r => setTimeout(r, ms));
  await esperar(500);
  const salida = {};
  const btn = document.getElementById('btn-lote-movil');
  salida.botonVisible = !!btn && !btn.classList.contains('hidden');
  salida.qrcodeLib = typeof qrcode !== 'undefined';
  const r = await window.puenteMovil.iniciar();
  salida.urlPuente = r && r.url;
  if (btn) btn.click();
  await esperar(900);
  salida.modalAbierto = !document.getElementById('puente-modal').classList.contains('hidden');
  salida.qrGenerado = !!document.querySelector('#puente-qr-box img');
  return salida;
})()`;

const GUION_FOTO = `(async () => {
  // "Foto" de la papeleta impresa, como haría la cámara del móvil
  const c = document.createElement('canvas'); c.width = 1000; c.height = 600;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1000, 600);
  x.fillStyle = '#000'; x.font = 'bold 40px Arial'; x.fillText('LONJA DE ALGARROBO', 50, 90);
  x.font = '38px Arial'; x.fillText('Lote: L-4521', 50, 200);
  x.fillText('Dorada 5,40 kg 8,90', 50, 300);
  return c.toDataURL('image/jpeg', 0.95);
})()`;

const GUION_LOTE = `document.getElementById('item-lote').value`;

function pedir(host, puerto, ruta) {
  return new Promise((resolve, reject) => {
    http.get({ host, port: puerto, path: ruta }, (res) => {
      let d = '';
      res.on('data', t => d += t);
      res.on('end', () => resolve({ status: res.statusCode, cuerpo: d }));
    }).on('error', reject);
  });
}

function postFoto(host, puerto, token, jpeg) {
  return new Promise((resolve, reject) => {
    const LIMITE = '----puente' + Date.now();
    const cuerpo = Buffer.concat([
      Buffer.from('--' + LIMITE + '\r\nContent-Disposition: form-data; name="foto"; filename="papeleta.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
      jpeg,
      Buffer.from('\r\n--' + LIMITE + '\r\nContent-Disposition: form-data; name="token"\r\n\r\n' + token + '\r\n--' + LIMITE + '--\r\n'),
    ]);
    const req = http.request({
      host, port: puerto, path: '/foto', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + LIMITE, 'Content-Length': cuerpo.length },
    }, (res) => {
      let d = '';
      res.on('data', t => d += t);
      res.on('end', () => resolve({ status: res.statusCode, cuerpo: d }));
    });
    req.on('error', reject);
    req.write(cuerpo);
    req.end();
  });
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

app.on('browser-window-created', (event, ventana) => {
    ventana.webContents.on('did-finish-load', async () => {
        if (terminado) return;
        terminado = true;
        const fallos = [];
        const check = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); if (!c) fallos.push(n); };
        const salida = {};
        try {
            Object.assign(salida, await ventana.webContents.executeJavaScript(GUION_INICIAR));
            check('botón 📱 visible en escritorio', salida.botonVisible);
            check('librería QR cargada', salida.qrcodeLib === true);
            check('puente iniciado con URL en el WiFi', typeof salida.urlPuente === 'string' && /^http:\/\/\d+\.\d+\./.test(salida.urlPuente));
            check('modal con el QR abierto', salida.modalAbierto === true && salida.qrGenerado === true);

            if (salida.urlPuente) {
                const u = new URL(salida.urlPuente);
                const token = u.pathname.slice(1);

                // El móvil abre la página
                const pagina = await pedir(u.hostname, u.port, u.pathname);
                check('el móvil ve la página del puente', pagina.status === 200 && pagina.cuerpo.includes('Hacer la foto'));

                // El móvil manda la foto
                const fotoDataUrl = await ventana.webContents.executeJavaScript(GUION_FOTO);
                const jpeg = Buffer.from(fotoDataUrl.split(',')[1], 'base64');
                const resp = await postFoto(u.hostname, u.port, token, jpeg);
                check('POST de la foto aceptado', resp.status === 200 && JSON.parse(resp.cuerpo).ok === true);

                // La ventana recibe la foto y el OCR rellena el lote
                let lote = '';
                for (let i = 0; i < 60; i++) {
                    await esperar(500);
                    lote = await ventana.webContents.executeJavaScript(GUION_LOTE);
                    if (/4521/.test(lote)) break;
                }
                salida.loteLeido = lote;
                check('la foto llegó del móvil y el OCR rellenó el lote', /4521/.test(lote));
                await ventana.webContents.executeJavaScript("document.getElementById('btn-cerrar-puente').click()");
            }
        } catch (err) {
            salida.error = err.message;
            fallos.push('excepción: ' + err.message);
        }
        console.log('PUENTE_E2E ' + JSON.stringify(salida));
        console.log(fallos.length ? '\n❌ E2E PUENTE CON FALLOS' : '\n✅ E2E PUENTE CORRECTA');
        app.exit(fallos.length ? 1 : 0);
    });
});

setTimeout(() => {
    if (!terminado) {
        console.error('❌ La ventana no llegó a cargar en 60 s');
        app.exit(1);
    }
}, 60000);
