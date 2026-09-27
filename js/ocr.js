/* ==========================================================================
   PESCADERÍA RANA - OCR DEL Nº DE LOTE (TRAZABILIDAD)
   Un único punto de OCR: el botón 📷 junto al campo «N° Lote» del facturador.
   Toma una foto de la papeleta y rellena el número de lote.

   Estrategias (en orden):
   1. IA Gemini Vision (si hay clave guardada y conexión): es la que mejor
      lee CÓDIGOS ESCRITOS A MANO.
   2. OCR local Tesseract con motor multi-pasada:
      - Recorte de la zona de la guía de la cámara (donde se encuadra el lote)
      - Binarización Otsu (umbral calculado para la foto, no fijo) y
        binarización adaptativa para trazos de bolígrafo finos
      - Modo "línea única" (PSM 7) y "palabra única" (PSM 8)
      - CORRECCIÓN AUTOMÁTICA: si el recorte no da nada, se prueban los
        números sueltos detectados en toda la foto
      - CONSENSO: un lote solo se acepta directo si 2 pasadas lo leen igual;
        si no, se presentan candidatos al usuario con un clic
   ========================================================================== */

let ocrLoteOcupado = false;
let ocrWorkerPromise = null;
let ocrUltimosCandidatos = [];   // para los chips «¿quisiste decir…?»

/* ---------- APRENDIZAJE DEL OCR (mejora con el uso) ----------
   No es una red neuronal: es MEMORIA DE CORRECCIONES, que es lo que de verdad
   hace que un OCR mejore en un negocio concreto:
   1. Si el OCR lee «X» y el usuario lo corrige a «Y», se guarda X→Y. La próxima
      vez que lea X, lo escribe solo como Y.
   2. Cada pasada (variante+modo) tiene un peso: la que acertó gana peso y la
      que falló lo pierde, así el consenso se ajusta a TU letra y TU cámara. */
const CLAVE_APRENDIZAJE = 'ocr_aprendizaje_v1';
let lastOcrResultado = null; // última lectura OCR, para aprender de las correcciones
let cacheAprendizaje = null;

async function cargarAprendizaje() {
  if (cacheAprendizaje) return cacheAprendizaje;
  try {
    const v = await getSetting(CLAVE_APRENDIZAJE, null);
    cacheAprendizaje = (v && typeof v === 'object') ? v : { correcciones: {}, pesoPasadas: {} };
  } catch (err) {
    cacheAprendizaje = { correcciones: {}, pesoPasadas: {} };
  }
  if (!cacheAprendizaje.correcciones) cacheAprendizaje.correcciones = {};
  if (!cacheAprendizaje.pesoPasadas) cacheAprendizaje.pesoPasadas = {};
  return cacheAprendizaje;
}

async function guardarAprendizaje() {
  if (!cacheAprendizaje) return;
  try { await saveSetting(CLAVE_APRENDIZAJE, cacheAprendizaje); } catch (err) { /* sin importancia */ }
}

/** Clave comparable de un lote: sin mayúsculas, guiones ni espacios */
function normalClaveLote(v) {
  return String(v || '').toLowerCase().replace(/[\s\-_#.]/g, '');
}

/** Devuelve la corrección aprendida para una lectura, si la hay */
async function aplicarAprendizaje(lote) {
  if (!lote) return lote;
  const ap = await cargarAprendizaje();
  const reg = ap.correcciones[normalClaveLote(lote)];
  return (reg && reg.a) ? reg.a : lote;
}

/** El OCR leía «mal» y el usuario lo dejó en «bien»: recordarlo para siempre */
async function aprenderCorreccion(mal, bien) {
  const cm = normalClaveLote(mal), cb = normalClaveLote(bien);
  if (!cm || !cb || cm === cb) return false;
  const ap = await cargarAprendizaje();
  ap.correcciones[cm] = { a: String(bien).trim(), t: Date.now() };
  // Memoria acotada: nos quedamos con las 60 correcciones más recientes
  const claves = Object.keys(ap.correcciones);
  if (claves.length > 60) {
    claves.sort((x, y) => (ap.correcciones[y].t || 0) - (ap.correcciones[x].t || 0));
    claves.slice(60).forEach(k => delete ap.correcciones[k]);
  }
  await guardarAprendizaje();
  return true;
}

/** Sube/baja el peso de una pasada concreta según acertó o falló */
async function reajustarPesoPasada(pasada, delta) {
  if (!pasada) return;
  const ap = await cargarAprendizaje();
  const actual = ap.pesoPasadas[pasada] === undefined ? 1 : ap.pesoPasadas[pasada];
  ap.pesoPasadas[pasada] = Math.max(0.3, Math.min(2.5, +(actual + delta).toFixed(2)));
  await guardarAprendizaje();
}

/** Motor Tesseract local: worker, núcleo WASM y español van en vendor/.
 *  Idioma INGLÉS para el motor de cifras: es más del doble de rápido que el
 *  español y los lotes son letras y números (el spa LSTM es más pesado y
 *  no aporta nada aquí). OEM 1 = LSTM. */
function getOcrWorker() {
  if (typeof Tesseract === 'undefined') {
    return Promise.reject(new Error('Tesseract.js no está cargado.'));
  }
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: 'vendor/tesseract/worker.min.js',
      corePath: 'vendor/tesseract/core',
      langPath: 'vendor/tesseract/lang',
      logger: () => { /* el progreso se muestra en el estado del campo */ },
      errorHandler: e => console.error('OCR error:', e),
    });
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; }); // permite reintentar
  }
  return ocrWorkerPromise;
}

function cargarImagen(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Dibuja la imagen en un canvas devolviendo (ctx, w, h) para trabajar sobre ella */
function canvasDeImagen(img, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, ctx };
}

/** Grises 0..255 de un canvas (Uint8Array w*h) */
function grisesDeCanvas(ctx, w, h) {
  const p = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    g[j] = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
  }
  return g;
}

/** Sube/baja el contraste engordando la tinta oscura (trazos finos de boli) */
function engordarTinta(g, w, h, umbralTinta = 110, factor = 0.55) {
  let min = 255, max = 0;
  for (let j = 0; j < g.length; j++) {
    if (g[j] < min) min = g[j];
    if (g[j] > max) max = g[j];
  }
  const rango = Math.max(1, max - min);
  const out = new Uint8Array(g.length);
  for (let j = 0; j < g.length; j++) {
    let v = ((g[j] - min) * 255) / rango;
    if (v < umbralTinta) v = v * factor;
    out[j] = v;
  }
  return out;
}

/** Escribe un array de grises en un canvas (RGB iguales) */
function pintarGrises(canvas, g) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const datos = ctx.createImageData(canvas.width, canvas.height);
  const p = datos.data;
  for (let j = 0, i = 0; j < g.length; j++, i += 4) {
    p[i] = p[i + 1] = p[i + 2] = g[j];
    p[i + 3] = 255;
  }
  ctx.putImageData(datos, 0, 0);
  return canvas;
}

/** Umbral de Otsu: separa tinta/papel calculado sobre el histograma real */
function umbralOtsu(g) {
  const hist = new Array(256).fill(0);
  for (let j = 0; j < g.length; j++) hist[g[j]]++;
  const total = g.length;
  let sumaTotal = 0;
  for (let t = 0; t < 256; t++) sumaTotal += t * hist[t];
  let sumaB = 0, pesoB = 0, mejor = 0, mejorVar = -1;
  for (let t = 0; t < 256; t++) {
    pesoB += hist[t];
    if (!pesoB) continue;
    const pesoF = total - pesoB;
    if (!pesoF) break;
    sumaB += t * hist[t];
    const mediaB = sumaB / pesoB;
    const mediaF = (sumaTotal - sumaB) / pesoF;
    const varEntre = pesoB * pesoF * (mediaB - mediaF) * (mediaB - mediaF);
    if (varEntre > mejorVar) { mejorVar = varEntre; mejor = t; }
  }
  return mejor;
}

/** Binarización adaptativa con IMAGEN INTEGRAL: media local en O(1) por
 *  píxel (antes era O(ventana) por píxel y tardaba muchísimo en equipos
 *  antiguos). Mismo resultado: aguanta sombras y papel arrugado. */
function binarizarAdaptativa(g, w, h) {
  const W1 = w + 1;
  const integral = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let sumaFila = 0;
    for (let x = 0; x < w; x++) {
      sumaFila += g[y * w + x];
      integral[(y + 1) * W1 + (x + 1)] = integral[y * W1 + (x + 1)] + sumaFila;
    }
  }
  const out = new Uint8Array(g.length);
  const r = 8;                 // radio de la ventana (17x17)
  const C = 12;                // margen bajo el umbral local
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const suma = integral[(y1 + 1) * W1 + (x1 + 1)] - integral[y0 * W1 + (x1 + 1)]
                 - integral[(y1 + 1) * W1 + x0] + integral[y0 * W1 + x0];
      out[y * w + x] = g[y * w + x] < (suma / area) - C ? 0 : 255;
    }
  }
  return out;
}

/** Detección de la zona de tinta: promedia la oscuridad por filas y columnas
 *  (sobre una miniatura de 300px, coste insignificante) y devuelve el rectángulo
 *  donde se concentra el texto. Devuelve {x,y,w,h} en px de la imagen original
 *  con un 6% de margen, o null si la foto parece uniforme (sin texto claro). */
function detectarZonaTinta(img) {
  const M = 300; // lado de la miniatura de análisis
  const escala = Math.min(1, M / Math.max(img.width, img.height));
  const w = Math.max(16, Math.round(img.width * escala));
  const h = Math.max(16, Math.round(img.height * escala));
  const mini = document.createElement('canvas');
  mini.width = w; mini.height = h;
  const ctx = mini.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const g = grisesDeCanvas(ctx, w, h);

  // oscuro = 255 - gris
  const fila = new Float64Array(h);
  const col = new Float64Array(w);
  let maxF = 0, maxC = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = 255 - g[y * w + x];
      fila[y] += d; col[x] += d;
    }
  }
  for (let y = 0; y < h; y++) { fila[y] /= w; if (fila[y] > maxF) maxF = fila[y]; }
  for (let x = 0; x < w; x++) { col[x] /= h; if (col[x] > maxC) maxC = col[x]; }
  if (!maxF || !maxC) return null;

  const umbralF = maxF * 0.28;
  const umbralC = maxC * 0.28;
  let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
  for (let y = 0; y < h; y++) if (fila[y] >= umbralF) { if (y0 < 0) y0 = y; y1 = y; }
  for (let x = 0; x < w; x++) if (col[x] >= umbralC) { if (x0 < 0) x0 = x; x1 = x; }
  if (y0 < 0 || x0 < 0) return null;

  // margen del 6% del recorte a cada lado (mínimo 8px de miniatura)
  const mx = Math.max(4, Math.round((x1 - x0) * 0.06));
  const my = Math.max(4, Math.round((y1 - y0) * 0.06));
  x0 = Math.max(0, x0 - mx); x1 = Math.min(w - 1, x1 + mx);
  y0 = Math.max(0, y0 - my); y1 = Math.min(h - 1, y1 + my);

  const inv = 1 / escala; // de px de miniatura a px de la foto real
  return {
    x: Math.round(x0 * inv),
    y: Math.round(y0 * inv),
    w: Math.max(16, Math.round((x1 - x0 + 1) * inv)),
    h: Math.max(16, Math.round((y1 - y0 + 1) * inv)),
  };
}

/** Recorta un rectángulo {x,y,w,h} de la imagen reescalado a un ancho (con
 *  ampliación máx. 2x y reducción en dos pasos, como recorteGuia) */
function recortarRectangulo(img, r, anchoDeseado) {
  const sw = Math.min(r.w, img.width - r.x);
  const sh = Math.min(r.h, img.height - r.y);
  const ancho = Math.round(Math.min(anchoDeseado, sw * 2));
  const alto = Math.max(16, Math.round(ancho * sh / sw));
  const c = document.createElement('canvas');
  c.width = ancho; c.height = alto;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.x, r.y, sw, sh, 0, 0, ancho, alto);
  return { c, ctx };
}

/** Recorta la ZONA DE LA GUÍA de la cámara (con margen) reescalada a un ancho
 *  determinado. Reducir va en dos pasos para no perder trazos finos de
 *  bolígrafo (un reescalado directo de 4000px a 1100px los borra); si el
 *  recorte es pequeño se AMPLÍA hasta 2x: las papeletas con letra pequeña
 *  necesitan píxeles para el OCR. */
function recorteGuia(img, anchoDeseado) {
  const rx = 0.10, ry = 0.28, rw = 0.80, rh = 0.44;   // zona guía + margen
  const sx = Math.round(img.width * rx);
  const sy = Math.round(img.height * ry);
  const sw = Math.max(16, Math.round(img.width * rw));
  const sh = Math.max(16, Math.round(img.height * rh));
  const ancho = Math.round(Math.min(anchoDeseado, sw * 2));  // amplía máx. 2x
  if (sw <= ancho) {
    // Ampliación (o tamaño exacto) en un solo paso
    const c = document.createElement('canvas');
    c.width = ancho;
    c.height = Math.max(16, Math.round(ancho * sh / sw));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return { c, ctx };
  }
  // Reducción en dos pasos (mitad, luego a destino)
  const paso1W = sw > ancho * 2 ? ancho * 2 : sw;
  const paso1H = Math.max(16, Math.round(paso1W * sh / sw));
  const paso1 = document.createElement('canvas');
  paso1.width = paso1W; paso1.height = paso1H;
  let ctx = paso1.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, paso1W, paso1H);
  const c = document.createElement('canvas');
  c.width = ancho;
  c.height = Math.max(16, Math.round(ancho * sh / sw));
  ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(paso1, 0, 0, c.width, c.height);
  return { c, ctx };
}

/** Foto entera reducida a un lado máximo, en grises con un filtro opcional.
 *  Tamaños menores que antes: el OCR no gana nada con 2000px y los equipos
 *  modestos lo agradecen muchísimo (menos píxeles = menos segundos). */
function fotoReducida(img, ladoMax, filtro = null) {
  const mayor = Math.max(img.width, img.height);
  const factor = mayor > ladoMax ? ladoMax / mayor : 1;
  const { canvas, ctx } = canvasDeImagen(img, img.width * factor, img.height * factor);
  let g = grisesDeCanvas(ctx, canvas.width, canvas.height);
  if (filtro === 'engordar') g = engordarTinta(g, canvas.width, canvas.height);
  else if (filtro === 'otsu') g = binarizarOtsu(g);
  else if (filtro === 'otsu-rayas-dilata') {
    g = binarizarOtsu(g);
    g = quitarRayasHorizontales(g, canvas.width, canvas.height);
    g = dilatarTinta(g, canvas.width, canvas.height);
  } else if (filtro === 'negativo') {
    const out = new Uint8Array(g.length);
    for (let j = 0; j < g.length; j++) out[j] = 255 - g[j];
    g = out;
  }
  pintarGrises(canvas, g);
  return canvas;
}

/**
 * Genera las variantes de la foto, ordenadas de MÁS PROBABLE a menos y todas
 * ellas EN PEQUEÑO (rápido en equipos antiguos). En cuanto una pasada acierte
 * con confianza (>= 50), el bucle no sigue: las de atrás rara vez hacen falta.
 */
async function variantesDeImagen(imageBase64) {
  const variantes = [];
  let img;
  try {
    img = await cargarImagen(imageBase64);
  } catch (err) {
    return [{ nombre: 'completa', data: imageBase64 }]; // nunca romper el escaneo
  }

  // 1) Recorte de la guía ANTI-RAYADO (bolígrafo sobre cuaderno): la más fiable
  try {
    const { c, ctx } = recorteGuia(img, 1100);
    let g = grisesDeCanvas(ctx, c.width, c.height);
    g = engordarTinta(g, c.width, c.height);
    g = binarizarOtsu(g);
    g = quitarRayasHorizontales(g, c.width, c.height);
    g = dilatarTinta(g, c.width, c.height);
    pintarGrises(c, g);
    variantes.push({ nombre: 'guia-cifras', data: c.toDataURL('image/jpeg', 0.95), recorte: true });
  } catch (err) { /* seguimos */ }

  // 2) Recorte de la guía en gris (impresiones nítidas)
  try {
    const { c } = recorteGuia(img, 1100);
    variantes.push({ nombre: 'guia', data: c.toDataURL('image/jpeg', 0.95), recorte: true });
  } catch (err) { /* seguimos */ }

  // 3) Completa anti-rayado (por si el código está fuera de la guía)
  try {
    variantes.push({ nombre: 'rayado', data: fotoReducida(img, 1200, 'otsu-rayas-dilata').toDataURL('image/jpeg', 0.95) });
  } catch (err) { /* seguimos */ }

  // 4) Completa en gris con tinta engordada
  try {
    variantes.push({ nombre: 'completa', data: fotoReducida(img, 1200, 'engordar').toDataURL('image/jpeg', 0.95) });
  } catch (err) {
    variantes.push({ nombre: 'completa', data: imageBase64 });
  }

  // 5) Recorte con binarización adaptativa (sombras/pliegues)
  try {
    const { c, ctx } = recorteGuia(img, 900);
    const g = grisesDeCanvas(ctx, c.width, c.height);
    pintarGrises(c, dilatarTinta(binarizarAdaptativa(g, c.width, c.height), c.width, c.height));
    variantes.push({ nombre: 'guia-adapt', data: c.toDataURL('image/jpeg', 0.95), recorte: true });
  } catch (err) { /* seguimos */ }

  // 6) ZONA DETECTADA: busco DÓNDE está la tinta en la foto (proyección de
  //    oscuridad por filas y columnas). Así funciona aunque el código NO esté
  //    en la zona de la guía: fotos del móvil hechas a mano al alba, papeleta
  //    ladeada, capturas recortadas… Primero en GRIS (la más fiable), luego
  //    anti-rayado y adaptativa como reservas.
  try {
    const zona = detectarZonaTinta(img);
    if (zona) {
      const g1 = recortarRectangulo(img, zona, 1100);
      let gz = grisesDeCanvas(g1.ctx, g1.c.width, g1.c.height);
      gz = engordarTinta(gz, g1.c.width, g1.c.height);
      pintarGrises(g1.c, gz);
      variantes.unshift({ nombre: 'zona', data: g1.c.toDataURL('image/jpeg', 0.95), recorte: true });

      const g2 = recortarRectangulo(img, zona, 1000);
      let g = grisesDeCanvas(g2.ctx, g2.c.width, g2.c.height);
      g = engordarTinta(g, g2.c.width, g2.c.height);
      g = binarizarOtsu(g);
      g = quitarRayasHorizontales(g, g2.c.width, g2.c.height);
      g = dilatarTinta(g, g2.c.width, g2.c.height);
      pintarGrises(g2.c, g);
      variantes.push({ nombre: 'zona-cifras', data: g2.c.toDataURL('image/jpeg', 0.95), recorte: true });
    }
  } catch (err) { /* seguimos */ }

  // 6) Reservas: binaria entera y negativo (papel oscuro)
  try { variantes.push({ nombre: 'binaria', data: fotoReducida(img, 1000, 'otsu').toDataURL('image/jpeg', 0.95) }); } catch (err) { /* */ }
  try { variantes.push({ nombre: 'invertida', data: fotoReducida(img, 900, 'negativo').toDataURL('image/jpeg', 0.95) }); } catch (err) { /* */ }

  return variantes;
}

function binarizarOtsu(g) {
  const u = umbralOtsu(g);
  const out = new Uint8Array(g.length);
  for (let j = 0; j < g.length; j++) out[j] = g[j] <= u ? 0 : 255;
  return out;
}

/** Quita las líneas horizontales del PAPEL RAYADO (sobre imagen binarizada:
 *  tinta=0, papel=255). Una fila donde más de la mitad es tinta y corre de
 *  lado a lado es una raya del cuaderno, no una cifra. */
function quitarRayasHorizontales(g, w, h) {
  const out = new Uint8Array(g);
  for (let y = 0; y < h; y++) {
    let oscuros = 0;
    for (let x = 0; x < w; x++) if (g[y * w + x] === 0) oscuros++;
    if (oscuros > w * 0.55) {
      for (let x = 0; x < w; x++) {
        out[y * w + x] = 255;
        if (y > 0) out[(y - 1) * w + x] = 255;
        if (y < h - 1) out[(y + 1) * w + x] = 255;
      }
      y++; // la vecina ya quedó limpiada
    }
  }
  return out;
}

/** Dilatación morfológica de la tinta: engorda los trazos finos de bolígrafo
 *  (filtro mínimo 3x3 sobre los grises). Clave para que el LSTM vea el palo
 *  de un «1» o el rabillo de una cifra escrita a mano. */
function dilatarTinta(g, w, h) {
  const out = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 255;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const fila = yy * w;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = g[fila + xx];
          if (q < v) v = q;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Busca el nº de lote en texto libre (formatos: "Lote: L-4521", "Lote #849",
 *  "L. 4521", "L-4521", "Nº 104", "LOTE 2026-05", "codigo 4521"). Si la línea
 *  dice "lote/código/cod" y hay UN número suelto, se acepta directamente. */
function extraerLoteDeTexto(texto) {
  if (!texto) return { lote: '', sueltos: [] };
  const t = String(texto);

  const patrones = [
    /(?:lote|lot|cod(?:igo)?|batch)(?![a-z])\s*(?:n[ºo°])?\s*[:#=.\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/.]{1,15})/i,
    /\b([A-Za-z]{1,3}[-\s]?\d{2,8})\b/,
    /\b#\s?(\d{2,8})\b/,
    /\bn[ºo°]\s*(\d{3,8})\b/i,
  ];
  for (const re of patrones) {
    const m = t.match(re);
    if (m && m[1]) return { lote: m[1].replace(/[.,;:]+$/, '').trim(), sueltos: [] };
  }

  // Números "sueltos" de 2-8 cifras tal cual se leyeron (posibles lotes
  // solo numéricos). NO se recortan: un 4521 mal recortado daría 457.
  const sueltos = [];
  const reNum = /\b\d{2,8}\b/g;
  let m2;
  while ((m2 = reNum.exec(t)) !== null) sueltos.push(m2[0]);

  // Si el texto menciona lote/código pero no casó ningún patrón con formato,
  // y solo hay un número en la foto: es el lote casi seguro
  const mencionaLote = /lot|cod|batch|n[ºo°]/i.test(t);
  const unicos = [...new Set(sueltos)];
  if (mencionaLote && unicos.length === 1) {
    return { lote: unicos[0], sueltos: unicos };
  }
  return { lote: '', sueltos: unicos };
}

/** Quita el prefijo "Lote" si la IA lo devuelve con palabra incluida */
function normalizarLote(valor) {
  if (!valor) return '';
  return String(valor).replace(/^lote\s*[:#.=]?\s*/i, '').replace(/[.,;:]+$/, '').trim();
}

/**
 * Corrige confusiones típicas del OCR cuando el lote mezcla letras y números:
 * O→0, I/l→1, S→5, B→8, Z→2, g→9, T→7, G→6.
 * Además arregla el caso habitual "l4521"/"14521" → "L-4521": la L inicial se
 * lee como l o como 1, y los manuscritos casi nunca llevan el guión.
 */
function corregirLoteOcr(valor) {
  if (!valor) return valor;
  let v = String(valor).trim();
  v = v.replace(/^[lL]ote\s*[:#.=]?\s*/, '');

  // "l4521" / "L 4521" → "L-4521" (prefijo L pegado a cifras)
  const prefijoL = v.match(/^[lL][\s]?(?=\d)/);
  if (prefijoL) v = 'L-' + v.slice(prefijoL[0].length);
  // "14521" con 5+ cifras donde la primera puede ser una L mal leída → L-4521
  else if (/^1\d{4,7}$/.test(v)) v = 'L-' + v.slice(1);

  const etiqueta = v.match(/^([lL])[-\s.:#]?/);
  const cuerpo = etiqueta ? v.slice(etiqueta[0].length) : v;
  if (/[A-Za-z]/.test(cuerpo) && /\d/.test(cuerpo)) {
    v = (etiqueta ? etiqueta[0] : '') + cuerpo.replace(/[A-Za-z0-9]+/g, (bloque) => {
      if (!/\d/.test(bloque) || !/[A-Za-z]/.test(bloque)) return bloque;
      return bloque.replace(/O/g, '0').replace(/o/g, '0')
        .replace(/I/g, '1').replace(/l/g, '1')
        .replace(/S/g, '5').replace(/B/g, '8')
        .replace(/Z/g, '2').replace(/g/g, '9')
        .replace(/T/g, '7').replace(/G/g, '6');
    });
  }
  return v;
}

function sonLotesIguales(a, b) {
  return String(a).toLowerCase().replace(/[\s\-_#.]/g, '') === String(b).toLowerCase().replace(/[\s\-_#.]/g, '');
}

/** Peso del voto de una pasada según su confianza: las lecturas confiadas
 *  (p. ej. modo «palabra» sobre el recorte) mandan sobre las de relleno,
 *  que casi siempre leen ruido. */
function pesoVoto(conf) {
  if (conf >= 60) return 3;
  if (conf >= 35) return 2;
  return 1;
}

/** Añade un candidato evitando duplicados "fuzzys" y recordando de qué
 *  pasada (variante+modo) salió su mejor lectura */
function pushCandidato(lista, lote, confianza, peso = 1, fuente = '') {
  if (!lote) return;
  const limpio = normalizarLote(corregirLoteOcr(lote));
  if (!limpio || limpio.length < 2 || limpio.length > 20) return;
  const ya = lista.find(c => sonLotesIguales(c.lote, limpio));
  if (ya) {
    if (fuente && confianza > ya.confianza) ya.fuente = fuente;
    ya.votos += peso;
    ya.confianza = Math.max(ya.confianza, confianza);
  } else {
    lista.push({ lote: limpio, votos: peso, confianza, fuente });
  }
}

/** Extrae el lote con el Agente IA (requiere clave guardada y conexión).
 *  Devuelve también todos los "posibles lotes" que vea en la foto. */
async function leerLoteConIA(imageBase64) {
  const resultado = await processWithGeminiAI(imageBase64);
  if (resultado && resultado.lote) return resultado;
  return { lote: '', sueltos: [] };
}

/**
 * Lee la papeleta. IA opcional primero (si hay clave y red); OCR local con
 * motor multi-pasada después. Devuelve { lote, fuente, confianza, sueltos }.
 */
async function leerLoteDePapeleta(imageBase64) {
  // ORDEN: LOCAL PRIMERO (rápido: las papeletas IMPRESAS se leen en 0,2-0,5 s)
  // y la IA (lenta, 8-12 s) solo cuando el local duda o no encuentra nada.
  // Si un día se quiere la IA siempre primero, variable: ocrIAprimero = true.
  const ocrIAprimero = false;
  const apiKey = await getSetting('gemini_api_key', '');
  const hayIA = apiKey && navigator.onLine;

  if (!ocrIAprimero) {
    const local = await leerLoteLocal(imageBase64);
    // Solo aceptamos la lectura local sin recurrir a la IA si fue MUY confiada
    // Y de una variante fiable Y el lote parece limpio (una sola pieza alfanumérica
    // con separadores normales; "lL 49521" con espacios raros no vale).
    const loteLimpio = local.lote && /^[A-Za-z]?[-\s]?[A-Za-z0-9\-/]{2,15}$/.test(local.lote) && !/\s.*\s/.test(local.lote);
    if (local.lote && (local.confianza || 0) >= 70 && local.fuenteSinDuda && loteLimpio) {
      return local;
    }
    if (hayIA) {
      try {
        const r = await leerLoteConIA(imageBase64);
        if (r.lote) return { lote: r.lote, fuente: 'IA Vision (Gemini)', confianza: null, sueltos: r.sueltos || [] };
        if (r.sueltos && r.sueltos.length) return { lote: local.lote || '', fuente: local.lote ? 'OCR local (IA no encontró mejor)' : 'IA Vision (Gemini)', confianza: local.confianza || null, sueltos: r.sueltos };
      } catch (err) {
        console.warn('IA no disponible:', err.message);
      }
    }
    return local;
  }

  // (Modo IA primero, por si se activa: igual que la versión anterior)
  if (hayIA) {
    try {
      const r = await leerLoteConIA(imageBase64);
      if (r.lote) return { lote: r.lote, fuente: 'IA Vision (Gemini)', confianza: null, sueltos: r.sueltos || [] };
      if (r.sueltos && r.sueltos.length) return { lote: '', fuente: 'IA Vision (Gemini)', confianza: null, sueltos: r.sueltos };
    } catch (err) {
      console.warn('IA no disponible, usando OCR local:', err.message);
    }
  }
  return await leerLoteLocal(imageBase64);
}

/** El motor multi-pasada local (lo que antes era el cuerpo de leerLoteDePapeleta) */
async function leerLoteLocal(imageBase64) {
  const worker = await getOcrWorker();
  const variantes = await variantesDeImagen(imageBase64);
  const candidatos = [];
  const sueltosGlobal = new Set();
  const pasos = [];
  const ap = await cargarAprendizaje(); // pesos aprendidos con tu letra/cámara

  for (let i = 0; i < variantes.length; i++) {
    const vari = variantes[i];

    // Modo según variante: los recortes y el rayado casi siempre son UNA línea.
    // Dos-tres pasadas por variante como máximo: con el paro temprano (conf >= 50)
    // lo normal es acertar en la 1ª-3ª pasada y no llegar al resto.
    const modos = vari.recorte
      ? [{ psm: '7', nombre: 'línea' }, { psm: '8', nombre: 'palabra' }, { psm: '6', nombre: 'bloque' }]
      : vari.nombre === 'rayado'
        ? [{ psm: '7', nombre: 'línea' }, { psm: '11', nombre: 'disperso' }]
        : [{ psm: '6', nombre: 'bloque' }, { psm: '11', nombre: 'disperso' }];

    for (const modo of modos) {
      const clavePasada = vari.nombre + '/' + modo.nombre;
      const pesoPasada = (ap.pesoPasadas[clavePasada] !== undefined) ? ap.pesoPasadas[clavePasada] : 1;
      pasos.push(vari.nombre + '·' + modo.nombre);
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: modo.psm,
          preserve_interword_spaces: '1',
        });
        const result = await worker.recognize(vari.data);
        const conf = (result.data && typeof result.data.confidence === 'number') ? result.data.confidence : 0;
        const texto = result.data.text || '';
        const { lote, sueltos } = extraerLoteDeTexto(texto);
        console.log('OCR ' + vari.nombre + '/' + modo.nombre + ': conf=' + Math.round(conf) + '% lote=' + (lote || '—') + ' sueltos=[' + sueltos.join(', ') + ']');
        pushCandidato(candidatos, lote, Math.round(conf), pesoVoto(Math.round(conf)) * pesoPasada, clavePasada);
        for (const s of sueltos) {
          if (s.length >= 2) {
            // En un recorte el lote es lo ÚNICO que hay: sus números valen
            // confianza plena; en la foto entera son solo posibles lotes.
            const confS = vari.recorte ? Math.round(conf) : Math.max(0, Math.round(conf) - 20);
            pushCandidato(candidatos, s, confS, pesoVoto(Math.round(conf)) * pesoPasada, clavePasada);
            sueltosGlobal.add(s);
          }
        }
        // Éxito fuerte: formato claro (letras-guión) o lectura confiada → parar.
        // Las variantes más preparadas van primero: su lectura manda.
        if (lote && (/[A-Za-z]-\d/.test(lote) || conf >= 50)) {
          await restaurarWorker(worker);
          const crudo = corregirLoteOcr(lote);
          const final = await aplicarAprendizaje(crudo);
          return { lote: final, crudo, aprendido: final !== crudo, fuenteSinDuda: !/disperso/.test(clavePasada), fuente: 'OCR local (' + vari.nombre + ', ' + modo.nombre + ')', pasada: clavePasada, confianza: Math.round(conf), sueltos: [...sueltosGlobal] };
        }
      } catch (err) {
        console.warn('OCR ' + vari.nombre + '/' + modo.nombre + ' falló:', err.message);
      }
    }
  }

  await restaurarWorker(worker);

  // ---- Decisión final por consenso ----
  // Las lecturas FUERTES (conf >= 45%) mandan: evita que muchas pasadas
  // débiles llenas de ruido entierren la única pasada que leyó bien.
  const fuertes = candidatos.filter(c => c.confianza >= 45);
  const pool = fuertes.length ? fuertes : candidatos;
  pool.sort((a, b) => (b.confianza - a.confianza) || (b.votos - a.votos));
  const top = pool[0];
  const segundo = pool[1];
  // Un solo candidato o el primero ganó claramente → rellenarlo
  if (top && (!segundo || top.votos > segundo.votos || top.confianza - segundo.confianza >= 15)) {
    const final = await aplicarAprendizaje(top.lote);
    return { lote: final, crudo: top.lote, aprendido: final !== top.lote, fuenteSinDuda: !/disperso/.test(top.fuente || ''), fuente: 'OCR local (mejor lectura)', pasada: top.fuente || '', confianza: top.confianza, sueltos: [...sueltosGlobal] };
  }
  // Empate/duda → devolver el mejor como principal y el resto como alternativas
  if (top) {
    const final = await aplicarAprendizaje(top.lote);
    return { lote: final, crudo: top.lote, aprendido: final !== top.lote, fuenteSinDuda: false, fuente: 'OCR local (¿quisiste decir…?)', pasada: top.fuente || '', confianza: top.confianza, sueltos: [...sueltosGlobal], alternativas: candidatos.slice(1, 5).map(c => c.lote) };
  }
  return { lote: '', fuente: 'OCR local', confianza: null, sueltos: [...sueltosGlobal] };
}

/** Si el usuario, tras un OCR fallido, escribe el lote a mano en el campo,
 *  se aprende: la lectura cruda del OCR pasa a corregirse sola a lo escrito. */
async function aprendeOcrDeCampo() {
  try {
    if (!lastOcrResultado || !lastOcrResultado.crudo || ocrLoteOcupado) return;
    const campo = document.getElementById('item-lote');
    if (!campo) return;
    const escrito = String(campo.value || '').trim();
    if (!escrito) return;
    if (sonLotesIguales(escrito, lastOcrResultado.crudo)) return; // lo dejó igual
    const aprendido = await aprenderCorreccion(lastOcrResultado.crudo, escrito);
    if (lastOcrResultado.pasada) await reajustarPesoPasada(lastOcrResultado.pasada, -0.3);
    if (aprendido) showToast('Anotado: cuando lea "' + lastOcrResultado.crudo + '" escribirá "' + escrito + '".');
    lastOcrResultado = null;
  } catch (err) { /* nunca estorbar al usuario */ }
}

/** Devuelve el worker a su modo por defecto para futuras lecturas */
async function restaurarWorker(worker) {
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '0' });
  } catch (err) { /* no pasa nada */ }
}

/** ---- Interfaz: botón 📷 junto al campo N° Lote ----
 *  Abre directamente la cámara (la del portátil) en una ventana modal para
 *  fotografiar la papeleta. Si no hay cámara o se deniega el permiso, cae al
 *  selector de archivos. */
let camaraStreamLote = null;

function initOcrLote() {
  const btn = document.getElementById('btn-ocr-lote');
  const input = document.getElementById('ocr-lote-input');
  const btnCapturar = document.getElementById('btn-capturar-lote');
  const btnCerrar = document.getElementById('btn-cerrar-camara');
  const btnArchivo = document.getElementById('btn-lote-archivo');
  if (!btn || !input) return;

  btn.addEventListener('click', () => {
    if (!ocrLoteOcupado) abrirCamaraLote();
  });
  if (btnCapturar) btnCapturar.addEventListener('click', capturarFotoLote);
  if (btnCerrar) btnCerrar.addEventListener('click', cerrarCamaraLote);
  if (btnArchivo) {
    btnArchivo.addEventListener('click', () => {
      cerrarCamaraLote();
      input.click();
    });
  }

  input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // permite repetir con el mismo fichero
    if (file) leerYRellenarLote(file);
  });

  // PUENTE MÓVIL: botón 📱 (solo se ve en la app de escritorio), cerrar y recepción
  const btnMovil = document.getElementById('btn-lote-movil');
  if (btnMovil) {
    if (window.ES_ESCRITORIO && window.puenteMovil) btnMovil.classList.remove('hidden');
    btnMovil.addEventListener('click', abrirPuenteMovil);
  }
  const btnCerrarPuente = document.getElementById('btn-cerrar-puente');
  if (btnCerrarPuente) btnCerrarPuente.addEventListener('click', cerrarPuenteMovil);
  const btnCerrarPuente2 = document.getElementById('btn-puente-cerrar2');
  if (btnCerrarPuente2) btnCerrarPuente2.addEventListener('click', cerrarPuenteMovil);
  if (window.puenteMovil && window.puenteMovil.alRecibirFoto) {
    window.puenteMovil.alRecibirFoto(recibirFotoDelMovil);
  }

  // Aprende cuando corriges el lote a mano tras una lectura
  const campoLote = document.getElementById('item-lote');
  if (campoLote) {
    campoLote.addEventListener('change', aprendeOcrDeCampo);
    campoLote.addEventListener('blur', aprendeOcrDeCampo);
  }

  // CLAVE DE IA DE FÁBRICA: si el envoltorio de escritorio trae una pendiente
  // (gemini-key.txt), se instala en Configuración una sola vez, en silencio.
  if (window.ES_ESCRITORIO && window.claveIAFabrica) {
    window.claveIAFabrica().then(async (clave) => {
      if (!clave) return;
      try {
        const actual = await getSetting('gemini_api_key', '');
        if (!actual) {
          await saveSetting('gemini_api_key', clave);
          console.log('Clave de IA instalada automáticamente (gemini-key.txt).');
        }
      } catch (err) { console.warn('No se pudo instalar la clave de IA:', err); }
    });
  }

  // Cerrar con la tecla Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && camaraStreamLote) cerrarCamaraLote();
  });
}

/** ¿Este dispositivo tiene cámara? (sin pedir permiso) */
async function hayCamaraDisponible() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return false;
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.some(d => d.kind === 'videoinput');
  } catch (err) {
    return false;
  }
}

async function abrirCamaraLote() {
  // PC sin cámara: sin abrir el modal, pasar directo a elegir la foto
  if (!(await hayCamaraDisponible())) {
    showToast('Este equipo no tiene cámara: elige la foto de la papeleta.', 'info');
    document.getElementById('ocr-lote-input').click();
    return;
  }

  const modal = document.getElementById('camera-lote-modal');
  const video = document.getElementById('camera-lote-video');
  const estado = document.getElementById('camera-lote-estado');
  const btnCapturar = document.getElementById('btn-capturar-lote');
  if (!modal || !video) return;

  modal.classList.remove('hidden');
  if (estado) estado.textContent = 'Abriendo cámara…';
  if (btnCapturar) btnCapturar.disabled = true;

  try {
    // Resolución alta: el OCR necesita píxeles. facingMode 'user' = cámara
    // frontal del portátil. Si falla, cualquier cámara.
    camaraStreamLote = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err1) {
    try {
      camaraStreamLote = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (err2) {
      try {
        camaraStreamLote = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err3) {
        console.warn('Cámara no disponible:', err3);
        cerrarCamaraLote();
        showToast('No se pudo abrir la cámara: elige la foto de la papeleta.', 'error');
        document.getElementById('ocr-lote-input').click();
        return;
      }
    }
  }

  video.srcObject = camaraStreamLote;
  if (estado) estado.textContent = 'Coloca el código dentro del recuadro y pulsa Capturar.';
  if (btnCapturar) btnCapturar.disabled = false;
}

function capturarFotoLote() {
  const video = document.getElementById('camera-lote-video');
  if (!video || !video.videoWidth) {
    showToast('La cámara aún no está lista. Espera un segundo.', 'error');
    return;
  }
  // Capturar a la máxima resolución disponible (a más píxeles, mejor OCR)
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    cerrarCamaraLote();
    if (blob) leerYRellenarLote(blob);
  }, 'image/jpeg', 0.95);
}

function cerrarCamaraLote() {
  if (camaraStreamLote) {
    camaraStreamLote.getTracks().forEach(track => track.stop());
    camaraStreamLote = null;
  }
  const video = document.getElementById('camera-lote-video');
  if (video) video.srcObject = null;
  const modal = document.getElementById('camera-lote-modal');
  if (modal) modal.classList.add('hidden');
  const estado = document.getElementById('camera-lote-estado');
  if (estado) estado.textContent = 'Abriendo cámara…';
  const btnCapturar = document.getElementById('btn-capturar-lote');
  if (btnCapturar) btnCapturar.disabled = true;
}

async function leerYRellenarLote(fileOrBlob) {
  const btn = document.getElementById('btn-ocr-lote');
  const icono = document.getElementById('ocr-lote-icon');
  const estado = document.getElementById('ocr-lote-status');
  const campo = document.getElementById('item-lote');

  ocrLoteOcupado = true;
  if (btn) btn.disabled = true;
  if (icono) icono.className = 'fa-solid fa-spinner fa-spin';
  if (estado) {
    estado.textContent = 'Leyendo el nº de lote de la papeleta…';
    estado.classList.remove('hidden');
  }

  try {
    const base64 = await new Promise((resolve, reject) => {
      // Puede llegar un Blob/File (cámara o fichero) o un dataURL (foto del móvil)
      if (typeof fileOrBlob === 'string' && fileOrBlob.startsWith('data:')) return resolve(fileOrBlob);
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
      reader.readAsDataURL(fileOrBlob);
    });

    window.__ultimaFotoLote = base64; // por si hay que ofrecer "Releer con IA"
    const res = await leerLoteDePapeleta(base64);
    ocrUltimosCandidatos = [];
    lastOcrResultado = (res && (res.crudo !== undefined || res.lote)) ? { crudo: res.crudo || '', pasada: res.pasada || '' } : null;

    if (res && res.lote) {
      const extra = res.confianza !== null && res.confianza !== undefined ? ' (' + res.confianza + '%)' : '';
      if (campo) campo.value = res.lote;
      ocrUltimosCandidatos = (res.alternativas || []).map(l => ({ lote: l }));
      if (estado) {
        estado.innerHTML = '';
        estado.appendChild(document.createTextNode('Nº de lote detectado: ' + res.lote + extra + (res.aprendido ? ' · aplicado lo que corregiste otra vez' : '') + ' — ' + res.fuente));
        if (ocrUltimosCandidatos.length) {
          estado.appendChild(document.createElement('br'));
          estado.appendChild(document.createTextNode('¿No es correcto? Otras lecturas: '));
          ocrUltimosCandidatos.forEach((c, idx) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'lote-alt-btn';
            chip.textContent = c.lote;
            chip.addEventListener('click', async () => {
              const campo2 = document.getElementById('item-lote');
              if (campo2) campo2.value = c.lote;
              showToast('Lote corregido a ' + c.lote);
              // LA APP APRENDE: esa lectura mala → lo que tú has dicho.
              // La próxima vez que tu letra dé esa lectura, se corregirá sola.
              if (lastOcrResultado && lastOcrResultado.crudo) {
                await aprenderCorreccion(lastOcrResultado.crudo, c.lote);
                if (lastOcrResultado.pasada) await reajustarPesoPasada(lastOcrResultado.pasada, -0.3);
                showToast('El OCR lo recordará para la próxima vez.');
              }
            });
            estado.appendChild(chip);
            if (idx < ocrUltimosCandidatos.length - 1) estado.appendChild(document.createTextNode(' '));
          });
        }
      }
      showToast('Nº de lote detectado: ' + res.lote + extra);
    } else {
      // Sin lote claro: ofrecer los números sueltos vistos como candidatos
      const sueltos = (res && res.sueltos ? res.sueltos : []).filter(s => s.length >= 2).slice(0, 5);
      if (sueltos.length) {
        ocrUltimosCandidatos = sueltos.map(l => ({ lote: l }));
        if (estado) {
          estado.innerHTML = '';
          estado.appendChild(document.createTextNode('No se identificó el lote con seguridad. ¿Era alguno de estos? '));
          sueltos.forEach((l, idx) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'lote-alt-btn';
            chip.textContent = l;
            chip.addEventListener('click', () => {
              const campo2 = document.getElementById('item-lote');
              if (campo2) campo2.value = l;
              showToast('Lote puesto: ' + l);
            });
            estado.appendChild(chip);
            if (idx < sueltos.length - 1) estado.appendChild(document.createTextNode(' '));
          });
        }
        showToast('Lote dudoso: elige una de las lecturas o escríbelo.', 'error');
      } else {
        if (estado) {
          estado.innerHTML = '';
          estado.appendChild(document.createTextNode('No se pudo leer el lote. '));
          if (navigator.onLine && (await getSetting('gemini_api_key', ''))) {
            const bIA = document.createElement('button');
            bIA.type = 'button';
            bIA.className = 'lote-alt-btn';
            bIA.textContent = '🤖 Releer con IA';
            bIA.addEventListener('click', () => {
              if (!window.__ultimaFotoLote) { showToast('Vuelve a hacer la foto.', 'error'); return; }
              estado.textContent = 'Releyendo con IA (puede tardar unos segundos)…';
              leerLoteConIA(window.__ultimaFotoLote).then(r => {
                if (r.lote) {
                  const c2 = document.getElementById('item-lote');
                  if (c2) c2.value = normalizarLote(corregirLoteOcr(r.lote));
                  showToast('IA: ' + normalizarLote(corregirLoteOcr(r.lote)));
                  estado.textContent = 'Leído por IA: ' + normalizarLote(corregirLoteOcr(r.lote));
                } else {
                  estado.textContent = 'La IA tampoco lo leyó. Escríbelo a mano.';
                }
              }).catch(e => { estado.textContent = 'IA no disponible: ' + e.message; });
            });
            estado.appendChild(bIA);
            estado.appendChild(document.createTextNode(' o escríbelo a mano.'));
          } else {
            estado.appendChild(document.createTextNode('Escríbelo a mano.'));
          }
        }
        showToast('No se detectó ningún nº de lote. Escríbelo a mano.', 'error');
      }
    }
  } catch (err) {
    console.error('OCR lote:', err);
    if (estado) estado.textContent = 'Error leyendo la papeleta: ' + err.message;
    showToast('Error leyendo la papeleta: ' + err.message, 'error');
  } finally {
    ocrLoteOcupado = false;
    if (btn) btn.disabled = false;
    if (icono) icono.className = 'fa-solid fa-camera-retro';
    setTimeout(() => { if (estado) estado.classList.add('hidden'); }, 20000);
  }
}

document.addEventListener('DOMContentLoaded', initOcrLote);

/* ==========================================================================
   PUENTE MÓVIL: la cámara del móvil como escáner del PC (solo escritorio)
   El PC enseña un QR; el móvil abre la página del puente por el WiFi, hace
   la foto y el PC la recibe y la pasa por el OCR automáticamente.
   ========================================================================== */
let puenteOcupado = false;

async function abrirPuenteMovil() {
  if (puenteOcupado) return;
  puenteOcupado = true;
  const modal = document.getElementById('puente-modal');
  const qrBox = document.getElementById('puente-qr-box');
  const estado = document.getElementById('puente-estado');
  try {
    if (typeof qrcode === 'undefined') throw new Error('Falta la librería del QR (vendor/qrcode.min.js).');
    if (!window.ES_ESCRITORIO || !window.puenteMovil || !window.puenteMovil.iniciar) {
      throw new Error('El puente del móvil está disponible en la app de escritorio.');
    }
    if (estado) estado.textContent = 'Abriendo el puente…';
    if (modal) modal.classList.remove('hidden');
    const r = await window.puenteMovil.iniciar();
    // Generar el QR con la URL del puente
    const qr = qrcode(0, 'M');
    qr.addData(r.url);
    qr.make();
    const lado = Math.min(230, Math.max(160, window.innerWidth - 180));
    const img = document.createElement('img');
    img.alt = 'Código QR para conectar el móvil';
    img.style.width = lado + 'px';
    img.style.height = lado + 'px';
    img.src = qr.createDataURL(8, 8);
    if (qrBox) { qrBox.innerHTML = ''; qrBox.appendChild(img); }
    if (estado) estado.textContent = '1) Abre la cámara del móvil y apunta al QR. 2) Pulsa «Hacer la foto» en la página que se abre. 3) La foto llega aquí y se lee sola. (Mismo WiFi)';
  } catch (err) {
    console.error('Puente móvil:', err);
    if (modal) modal.classList.add('hidden');
    showToast('No se pudo abrir el puente: ' + err.message, 'error');
  } finally {
    puenteOcupado = false;
  }
}

function cerrarPuenteMovil() {
  const modal = document.getElementById('puente-modal');
  if (modal) modal.classList.add('hidden');
  // La sesión del puente sigue abierta unos minutos por si se vuelve a abrir
}

/** Llega una foto del móvil (via Electron): leerla como las demás */
function recibirFotoDelMovil(dataUrl) {
  const modal = document.getElementById('puente-modal');
  if (modal) modal.classList.add('hidden');
  showToast('Foto recibida del móvil. Leyendo el lote…');
  leerYRellenarLote(dataUrl);
}

/* ==========================================================================
   AGENTE IA VISION (opcional): usa la clave guardada en Configuración.
   Si no hay clave o no hay conexión, el flujo cae al OCR local.
   ========================================================================== */
/** Prepara la imagen PARA LA IA: la reduce a un lado máximo de 1280px (una
 *  foto de móvil va por 3000-4000px y sobra: subirla entera es la mitad del
 *  retraso). Suficiente para leer letra manuscrita, rapidísimo de subir. */
async function prepararImagenParaIA(imageBase64) {
  try {
    const img = await cargarImagen(imageBase64);
    const LADO = 1280;
    const mayor = Math.max(img.width, img.height);
    if (mayor <= LADO) return imageBase64;
    const factor = LADO / mayor;
    const { canvas } = canvasDeImagen(img, img.width * factor, img.height * factor);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (err) {
    return imageBase64; // sin reducir, mejor lento que romper
  }
}

async function processWithGeminiAI(imageBase64) {
  const apiKey = await getSetting('gemini_api_key', '');

  if (!apiKey) {
    throw new Error('Sin clave de Gemini configurada.');
  }

  const reducida = await prepararImagenParaIA(imageBase64);
  const cleanBase64 = reducida.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');

  const prompt = `Analiza la foto de esta papeleta/albarán de venta de pescado/marisco de Pescadería Rana.

TAREA PRINCIPAL: encuentra el NÚMERO DE LOTE. Puede estar ESCRITO A MANO con bolígrafo o rotulador (letra poco clara, números y letras mezclados, a veces sin guiones, ej: "L-4521", "L4521", "4521", "Lote 104", "2026-05"). Lee los caracteres uno a uno y fíjate en los dígitos reales (una O mayúscula escrita a mano suele ser un 0; una letra l minúscula suele ser un 1).

Luego extrae la lista de productos pesqueros en un array JSON plano con esta estructura exacta:
[
  {
    "lote": "L-4521",
    "sueltos": ["4521", "104"],
    "concepto": "Gamba Blanca de Huelva",
    "cantidad": 12.5,
    "precio_kg": 18.50,
    "subtotal": 231.25
  }
]

El campo "lote" es el número de lote MÁS PROBABLE tal cual está escrito. El campo "sueltos" es un array con TODOS los demás números o códigos que veas en la foto (por si el principal está mal leído). Si no hay productos, devuelve un array con un único objeto que tenga solo "lote" y "sueltos".
No agregues explicaciones ni bloques markdown. Responde ÚNICAMENTE con el array JSON.`;

  // Modelos a probar: 'flash-latest' es un alias que Google mantiene siempre
  // en la versión estable actual (evita quedarse anticuado), con reserva a
  // una versión fija por si lo retiran en el futuro.
  const modelos = ['gemini-flash-latest', 'gemini-2.5-flash'];
  let ultimoError = null;

  for (const modelo of modelos) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: 'image/jpeg', data: cleanBase64 } }
              ]
            }
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 }
        })
      });

      if (!response.ok) {
        ultimoError = new Error(modelo + ': ' + response.status + ' ' + response.statusText);
        continue; // probar el siguiente modelo
      }

      const data = await response.json();
      const textResponse = data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts.map(p => p.text || '').join('')
        : '';

      const jsonMatch = textResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;
      const items = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(items)) continue;

      const primero = items[0] || {};
      const lote = normalizarLote(primero.lote) || '';
      const sueltos = Array.isArray(primero.sueltos)
        ? primero.sueltos.map(normalizarLote).filter(Boolean)
        : [];
      return { lote, sueltos };
    } catch (err) {
      ultimoError = err;
    }
  }

  if (ultimoError) throw ultimoError;
  return { lote: '', sueltos: [] };
}
