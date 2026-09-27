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

/** Motor Tesseract local: worker, núcleo WASM y español van en vendor/ */
function getOcrWorker() {
  if (typeof Tesseract === 'undefined') {
    return Promise.reject(new Error('Tesseract.js no está cargado.'));
  }
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker('spa', 1, {
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

/** Binarización adaptativa por bloque: aguanta sombras y papel arrugado */
function binarizarAdaptativa(g, w, h) {
  const out = new Uint8Array(g.length);
  const medio = 9;             // ventana 9x9 de medias locales
  const half = (medio - 1) / 2;
  const C = 12;                // margen bajo el umbral local
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let suma = 0, n = 0;
      for (let dy = -half; dy <= half; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -half; dx <= half; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          suma += g[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = g[y * w + x] < (suma / n) - C ? 0 : 255;
    }
  }
  return out;
}

/**
 * Genera TODAS las variantes de una misma foto para maximizar la lectura.
 * - full:     foto entera (por si el papel se encuadra lejos)
 * - guia:     recorte de la zona de la guía de la cámara, ampliado (la clave
 *             para manuscrito: el lote ocupa casi todo el recorte)
 * - binaria:  foto entera con umbral Otsu
 * - adapt:    recorte guía con binarización adaptativa (sombras/pliegues)
 * - invertida: foto entera en negativo
 */
async function variantesDeImagen(imageBase64) {
  const variantes = [];
  let img;
  try {
    img = await cargarImagen(imageBase64);
  } catch (err) {
    return [imageBase64]; // nunca romper el escaneo
  }

  // 0) ANTI-RAYADO PRIMERO: la combinación que mejor funciona con bolígrafo
  //    sobre papel de cuaderno (binarizar + quitar rayas + engordar trazos)
  try {
    const LADO = 1800;
    const mayor = Math.max(img.width, img.height);
    const factor = mayor > LADO ? LADO / mayor : 1;
    let { canvas, ctx } = canvasDeImagen(img, img.width * factor, img.height * factor);
    let g = grisesDeCanvas(ctx, canvas.width, canvas.height);
    g = binarizarOtsu(g);
    g = quitarRayasHorizontales(g, canvas.width, canvas.height);
    g = dilatarTinta(g, canvas.width, canvas.height);
    pintarGrises(canvas, g);
    variantes.push({ nombre: 'rayado', data: canvas.toDataURL('image/jpeg', 0.95) });
  } catch (err) { /* seguimos */ }

  // 1) Foto entera mejorada (grises + contraste + tinta engordada)
  try {
    const LADO = 2000;
    const mayor = Math.max(img.width, img.height);
    let factor = mayor > LADO ? LADO / mayor : (mayor < 1000 ? Math.min(3, 1400 / mayor) : 1);
    let { canvas, ctx } = canvasDeImagen(img, img.width * factor, img.height * factor);
    let g = grisesDeCanvas(ctx, canvas.width, canvas.height);
    g = engordarTinta(g, canvas.width, canvas.height);
    pintarGrises(canvas, g);
    variantes.push({ nombre: 'completa', data: canvas.toDataURL('image/jpeg', 0.95) });
  } catch (err) {
    variantes.push({ nombre: 'completa', data: imageBase64 });
  }

  // 2) Recorte de la ZONA DE LA GUÍA de la cámara (lote 18-82% x 32-68%)
  //    con margen holgado, reescalado en GRANDE (manuscrito necesita píxeles)
  try {
    const rx = 0.10, ry = 0.28, rw = 0.80, rh = 0.44; // zona guía + margen
    const sx = Math.round(img.width * rx);
    const sy = Math.round(img.height * ry);
    const sw = Math.max(16, Math.round(img.width * rw));
    const sh = Math.max(16, Math.round(img.height * rh));
    // el recorte final sube hasta 1600px de ancho
    const escala = Math.min(3, Math.max(1, 1600 / sw));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * escala);
    c.height = Math.round(sh * escala);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    variantes.push({ nombre: 'recorte-guia', data: c.toDataURL('image/jpeg', 0.95), recorte: true });

    // 2b) mismo recorte con Otsu
    const g = grisesDeCanvas(ctx, c.width, c.height);
    const c2 = document.createElement('canvas');
    c2.width = c.width; c2.height = c.height;
    pintarGrises(c2, binarizarOtsu(g));
    variantes.push({ nombre: 'recorte-guia-otsu', data: c2.toDataURL('image/jpeg', 0.95), recorte: true });
  } catch (err) { /* sin recorte, seguimos */ }

  // 3) Binaria (Otsu) de la foto entera
  try {
    const LADO = 1800;
    const mayor = Math.max(img.width, img.height);
    const factor = mayor > LADO ? LADO / mayor : 1;
    let { canvas, ctx } = canvasDeImagen(img, img.width * factor, img.height * factor);
    let g = grisesDeCanvas(ctx, canvas.width, canvas.height);
    pintarGrises(canvas, binarizarOtsu(g));
    variantes.push({ nombre: 'binaria', data: canvas.toDataURL('image/jpeg', 0.95) });
  } catch (err) { /* seguimos */ }

  // 3c) CIFRAS: recorte guía binarizado, sin rayas y con trazos engordados
  try {
    const rx = 0.10, ry = 0.28, rw = 0.80, rh = 0.44;
    const sx = Math.round(img.width * rx);
    const sy = Math.round(img.height * ry);
    const sw = Math.max(16, Math.round(img.width * rw));
    const sh = Math.max(16, Math.round(img.height * rh));
    const escala = Math.min(3, Math.max(1, 1600 / sw));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * escala);
    c.height = Math.round(sh * escala);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    let g = grisesDeCanvas(ctx, c.width, c.height);
    g = engordarTinta(g, c.width, c.height);
    g = binarizarOtsu(g);
    g = quitarRayasHorizontales(g, c.width, c.height);
    g = dilatarTinta(g, c.width, c.height);
    pintarGrises(c, g);
    variantes.push({ nombre: 'cifras', data: c.toDataURL('image/jpeg', 0.95), recorte: true, soloCifras: true });
  } catch (err) { /* seguimos */ }

  // 4) Binarización adaptativa del recorte guía (pliegues/sombras)
  try {
    const rx = 0.10, ry = 0.28, rw = 0.80, rh = 0.44;
    const sx = Math.round(img.width * rx);
    const sy = Math.round(img.height * ry);
    const sw = Math.max(16, Math.round(img.width * rw));
    const sh = Math.max(16, Math.round(img.height * rh));
    const escala = Math.min(3, Math.max(1, 1400 / sw));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * escala);
    c.height = Math.round(sh * escala);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    let g = grisesDeCanvas(ctx, c.width, c.height);
    pintarGrises(c, dilatarTinta(binarizarAdaptativa(g, c.width, c.height), c.width, c.height));
    variantes.push({ nombre: 'recorte-adapt', data: c.toDataURL('image/jpeg', 0.95), recorte: true });
  } catch (err) { /* seguimos */ }

  // 5) Invertida (por si el papel es oscuro)
  try {
    const LADO = 1600;
    const mayor = Math.max(img.width, img.height);
    const factor = mayor > LADO ? LADO / mayor : 1;
    let { canvas, ctx } = canvasDeImagen(img, img.width * factor, img.height * factor);
    let g = grisesDeCanvas(ctx, canvas.width, canvas.height);
    const out = new Uint8Array(g.length);
    for (let j = 0; j < g.length; j++) out[j] = 255 - g[j];
    pintarGrises(canvas, out);
    variantes.push({ nombre: 'invertida', data: canvas.toDataURL('image/jpeg', 0.95) });
  } catch (err) { /* seguimos */ }

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
  const apiKey = await getSetting('gemini_api_key', '');
  if (apiKey && navigator.onLine) {
    try {
      const r = await leerLoteConIA(imageBase64);
      if (r.lote) return { lote: r.lote, fuente: 'IA Vision (Gemini)', confianza: null, sueltos: r.sueltos || [] };
      if (r.sueltos && r.sueltos.length) return { lote: '', fuente: 'IA Vision (Gemini)', confianza: null, sueltos: r.sueltos };
    } catch (err) {
      console.warn('IA no disponible, usando OCR local:', err.message);
    }
  }

  const worker = await getOcrWorker();
  const variantes = await variantesDeImagen(imageBase64);
  const candidatos = [];
  const sueltosGlobal = new Set();
  const pasos = [];
  const ap = await cargarAprendizaje(); // pesos aprendidos con tu letra/cámara

  for (let i = 0; i < variantes.length; i++) {
    const vari = variantes[i];

    // Modo según variante: los recortes y el rayado casi siempre son UNA línea
    const modos = vari.nombre === 'rayado'
      ? [{ psm: '7', nombre: 'línea' }, { psm: '11', nombre: 'disperso' }, { psm: '6', nombre: 'bloque' }]
      : vari.recorte
        ? [{ psm: '7', nombre: 'línea' }, { psm: '8', nombre: 'palabra' }, { psm: '6', nombre: 'bloque' }]
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
          return { lote: final, crudo, aprendido: final !== crudo, fuente: 'OCR local (' + vari.nombre + ', ' + modo.nombre + ')', pasada: clavePasada, confianza: Math.round(conf), sueltos: [...sueltosGlobal] };
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
    return { lote: final, crudo: top.lote, aprendido: final !== top.lote, fuente: 'OCR local (mejor lectura)', pasada: top.fuente || '', confianza: top.confianza, sueltos: [...sueltosGlobal] };
  }
  // Empate/duda → devolver el mejor como principal y el resto como alternativas
  if (top) {
    const final = await aplicarAprendizaje(top.lote);
    return { lote: final, crudo: top.lote, aprendido: final !== top.lote, fuente: 'OCR local (¿quisiste decir…?)', pasada: top.fuente || '', confianza: top.confianza, sueltos: [...sueltosGlobal], alternativas: candidatos.slice(1, 5).map(c => c.lote) };
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

  // Aprende cuando corriges el lote a mano tras una lectura
  const campoLote = document.getElementById('item-lote');
  if (campoLote) {
    campoLote.addEventListener('change', aprendeOcrDeCampo);
    campoLote.addEventListener('blur', aprendeOcrDeCampo);
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
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
      reader.readAsDataURL(fileOrBlob);
    });

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
        if (estado) estado.textContent = 'No se pudo leer el lote. Escríbelo a mano.';
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
   AGENTE IA VISION (opcional): usa la clave guardada en Configuración.
   Si no hay clave o no hay conexión, el flujo cae al OCR local.
   ========================================================================== */
async function processWithGeminiAI(imageBase64) {
  const apiKey = await getSetting('gemini_api_key', '');

  if (!apiKey) {
    throw new Error('Sin clave de Gemini configurada.');
  }

  const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');

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

  // Modelos a probar: el nuevo flash primero, con reserva al 1.5 clásico
  const modelos = ['gemini-2.0-flash', 'gemini-1.5-flash'];
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
