/**
 * Pescadería Rana — prueba unitaria del puente móvil (solo Node, sin Electron).
 * Comprueba: la página del móvil se sirve, /ping responde, una foto POST con
 * token válido llega como dataURL por el evento 'puente-foto' y un token
 * malo es rechazado.
 *
 * Uso: node prueba-puente.js
 */

const http = require('node:http');
const { iniciarPuente } = require('./puente');

function pedir(host, ruta, metodo = 'GET', cuerpo = null, cabeceras = {}) {
  return new Promise((resolve, reject) => {
    const [h, p] = host.split(':');
    const req = http.request({ host: h, port: p || 80, path: ruta, method: metodo, headers: cabeceras }, (res) => {
      let datos = '';
      res.on('data', t => datos += t);
      res.on('end', () => resolve({ status: res.statusCode, cuerpo: datos }));
    });
    req.on('error', reject);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

/** URL sin "http://" → host y ruta */
function partirUrl(url) {
  const m = /^http:\/\/([^/]+)(\/.*)$/.exec(url);
  if (!m) throw new Error('URL inesperada: ' + url);
  return { host: m[1], ruta: m[2] };
}

(async () => {
  const fallos = [];
  const comprueba = (nombre, cond) => {
    console.log((cond ? '  ✅ ' : '  ❌ ') + nombre);
    if (!cond) fallos.push(nombre);
  };

  console.log('Arrancando el puente…');
  const puente = await iniciarPuente(8790);
  const { host, ruta } = partirUrl(puente.url);
  const token = ruta.slice(1);
  console.log('  URL del puente:', puente.url);

  // 1) La página del móvil se sirve con el token en la ruta
  const pagina = await pedir(host, ruta);
  comprueba('página del móvil responde 200', pagina.status === 200);
  comprueba('la página es la del puente', pagina.cuerpo.includes('Pescadería Rana') && pagina.cuerpo.includes('/foto'));

  // 2) Sin el token no hay nada
  const intruso = await pedir(host, '/');
  comprueba('sin token responde 404', intruso.status === 404);

  // 3) Ping
  const ping = await pedir(host, '/ping');
  comprueba('ping ok', ping.status === 200 && JSON.parse(ping.cuerpo).ok === true);

  // 4) POST de foto con token válido → evento 'puente-foto'
  const jpeg1x1 = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
    'base64'
  );
  const LIMITE = '----puente' + Date.now();
  const cuerpo = Buffer.concat([
    Buffer.from('--' + LIMITE + '\r\nContent-Disposition: form-data; name="foto"; filename="papeleta.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
    jpeg1x1,
    Buffer.from('\r\n--' + LIMITE + '\r\nContent-Disposition: form-data; name="token"\r\n\r\n' + token + '\r\n--' + LIMITE + '--\r\n'),
  ]);
  let fotoRecibida = null;
  process.on('puente-foto', d => { fotoRecibida = d; });
  const alta = await pedir(host, '/foto', 'POST', cuerpo, {
    'Content-Type': 'multipart/form-data; boundary=' + LIMITE,
    'Content-Length': cuerpo.length,
    'Host': host,
  });
  await new Promise(r => setTimeout(r, 150));
  comprueba('POST foto válido → ok', alta.status === 200 && JSON.parse(alta.cuerpo).ok === true);
  comprueba('la foto llegó como dataURL JPEG', typeof fotoRecibida === 'string' && fotoRecibida.startsWith('data:image/jpeg;base64,'));
  comprueba('los bytes JPEG llegan intactos', fotoRecibida && Buffer.from(fotoRecibida.split(',')[1], 'base64').equals(jpeg1x1));

  // 5) POST con token malo → 403
  const cuerpoMalo = Buffer.concat([
    Buffer.from('--' + LIMITE + '\r\nContent-Disposition: form-data; name="foto"; filename="x.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
    jpeg1x1,
    Buffer.from('\r\n--' + LIMITE + '\r\nContent-Disposition: form-data; name="token"\r\n\r\nffffffffffff\r\n--' + LIMITE + '--\r\n'),
  ]);
  const mala = await pedir(host, '/foto', 'POST', cuerpoMalo, {
    'Content-Type': 'multipart/form-data; boundary=' + LIMITE,
    'Content-Length': cuerpoMalo.length,
    'Host': host,
  });
  comprueba('token incorrecto rechazado (403)', mala.status === 403);

  puente.cerrar();
  console.log(fallos.length ? '\n❌ ' + fallos.length + ' fallo(s)' : '\n✅ PUENTE UNITARIO OK');
  process.exit(fallos.length ? 1 : 0);
})().catch(err => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
