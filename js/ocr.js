/* ==========================================================================
   PESCADERÍA RANA - OCR DEL Nº DE LOTE (TRAZABILIDAD)
   Un único punto de OCR: el botón 📷 junto al campo «N° Lote» del facturador.
   Toma una foto de la papeleta, la lee SIN CONEXIÓN (Tesseract empaquetado en
   vendor/tesseract, con preprocesado de imagen) y rellena el número de lote.
   Si el usuario ha guardado una clave de Gemini, se intenta primero la IA
   (eso sí usa internet) y cae al OCR local si no está disponible.
   ========================================================================== */

let ocrLoteOcupado = false;
let ocrWorkerPromise = null;

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

/**
 * Preprocesado de imagen para el OCR: reescala (las fotos de móvil suelen
 * venir pequeñas), pasa a gris, estira el contraste y oscurece la tinta.
 * Si algo falla, devuelve la imagen original (nunca rompe el escaneo).
 */
function preprocesarImagen(imageBase64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const LADO_GRANDE = 1700;
        const mayor = Math.max(img.width, img.height);
        let factor = 1;
        if (mayor > LADO_GRANDE) factor = LADO_GRANDE / mayor;
        else if (mayor < 900) factor = Math.min(3, 1200 / mayor);
        const w = Math.max(1, Math.round(img.width * factor));
        const h = Math.max(1, Math.round(img.height * factor));

        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);

        const datos = ctx.getImageData(0, 0, w, h);
        const p = datos.data;
        const grises = new Uint8ClampedArray(w * h);
        let min = 255, max = 0;
        for (let i = 0, j = 0; i < p.length; i += 4, j++) {
          const g = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
          grises[j] = g;
          if (g < min) min = g;
          if (g > max) max = g;
        }
        const rango = Math.max(1, max - min);
        for (let i = 0, j = 0; i < p.length; i += 4, j++) {
          let g = ((grises[j] - min) * 255) / rango;
          if (g < 110) g = g * 0.55; // engordar la tinta (trazos finos de bolígrafo)
          p[i] = p[i + 1] = p[i + 2] = g;
          p[i + 3] = 255;
        }
        ctx.putImageData(datos, 0, 0);
        resolve(c.toDataURL('image/jpeg', 0.95));
      } catch (err) {
        console.warn('Preprocesado no disponible, se usa la imagen original:', err);
        resolve(imageBase64);
      }
    };
    img.onerror = () => resolve(imageBase64);
    img.src = imageBase64;
  });
}

/** Busca el nº de lote en texto libre (formatos: "Lote: L-4521", "Lote #849",
 *  "L. 4521", "L-4521", "Nº 104", "LOTE 2026-05") */
function extraerLoteDeTexto(texto) {
  if (!texto) return '';
  const patrones = [
    /(?:lote|lot)\s*(?:n[ºo°])?\s*[:#.=]?\s*([A-Za-z0-9][A-Za-z0-9\-\/.]{1,15})/i,
    /\b([A-Za-z]{1,2}-\d{2,8})\b/,
    /\b#\s?(\d{2,8})\b/,
    /\bn[ºo°]\s*(\d{3,8})\b/i,
  ];
  for (const re of patrones) {
    const m = String(texto).match(re);
    if (m && m[1]) return m[1].replace(/[.,;:]+$/, '').trim();
  }
  return '';
}

/** Quita el prefijo "Lote" si la IA lo devuelve con palabra incluida */
function normalizarLote(valor) {
  if (!valor) return '';
  return String(valor).replace(/^lote\s*[:#.=]?\s*/i, '').replace(/[.,;:]+$/, '').trim();
}

/** Extrae el lote con el Agente IA (requiere clave guardada y conexión) */
async function leerLoteConIA(imageBase64) {
  const items = await processWithGeminiAI(imageBase64);
  if (items && items.length) {
    const candidato = normalizarLote(items[0].lote) || extraerLoteDeTexto(items[0].concepto || '');
    if (candidato) return candidato;
  }
  return '';
}

/**
 * Lee la papeleta y devuelve { lote, fuente, confianza }.
 * IA opcional primero (si hay clave y red), OCR local siempre como base.
 */
async function leerLoteDePapeleta(imageBase64) {
  const apiKey = await getSetting('gemini_api_key', '');
  if (apiKey && navigator.onLine) {
    try {
      const loteIA = await leerLoteConIA(imageBase64);
      if (loteIA) return { lote: loteIA, fuente: 'IA Vision', confianza: null };
    } catch (err) {
      console.warn('IA no disponible, usando OCR local:', err.message);
    }
  }

  const worker = await getOcrWorker();
  const lista = await preprocesarImagen(imageBase64);
  const result = await worker.recognize(lista);
  const confianza = (result.data && typeof result.data.confidence === 'number')
    ? Math.round(result.data.confidence) : null;
  const lote = extraerLoteDeTexto(result.data.text);
  return { lote, fuente: 'OCR local', confianza };
}

/** ---- Interfaz: botón 📷 junto al campo N° Lote ---- */
function initOcrLote() {
  const btn = document.getElementById('btn-ocr-lote');
  const input = document.getElementById('ocr-lote-input');
  if (!btn || !input) return;

  btn.addEventListener('click', () => {
    if (!ocrLoteOcupado) input.click();
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // permite repetir con el mismo fichero
    if (file) leerYRellenarLote(file);
  });
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

    if (res && res.lote) {
      const extra = res.confianza !== null && res.confianza !== undefined ? ' (' + res.confianza + '%)' : '';
      if (campo) campo.value = res.lote;
      if (estado) estado.textContent = 'Nº de lote detectado: ' + res.lote + extra + ' — ' + res.fuente;
      showToast('Nº de lote detectado: ' + res.lote + extra);
    } else {
      if (estado) estado.textContent = 'No se pudo leer el lote. Escríbelo a mano.';
      showToast('No se detectó ningún nº de lote. Escríbelo a mano.', 'error');
    }
  } catch (err) {
    console.error('OCR lote:', err);
    if (estado) estado.textContent = 'Error leyendo la papeleta: ' + err.message;
    showToast('Error leyendo la papeleta: ' + err.message, 'error');
  } finally {
    ocrLoteOcupado = false;
    if (btn) btn.disabled = false;
    if (icono) icono.className = 'fa-solid fa-camera-retro';
    setTimeout(() => { if (estado) estado.classList.add('hidden'); }, 8000);
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

  const prompt = `Analiza la foto de esta papeleta/albarán de venta de pescado/marisco para Pescadería Rana.
IMPORTANTE: Busca de forma prioritaria el NÚMERO DE LOTE (ej. "Lote #104", "L-2026-05", "Lote: 849", "Batch: 45").

Extrae la lista de productos pesqueros en un array JSON plano con la siguiente estructura exacta:
[
  {
    "lote": "Lote 2026-104",
    "concepto": "Gamba Blanca de Huelva",
    "cantidad": 12.5,
    "precio_kg": 18.50,
    "subtotal": 231.25
  }
]
No agregues explicaciones ni bloques markdown. Responde ÚNICAMENTE con el array JSON.`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
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
      ]
    })
  });

  if (!response.ok) {
    throw new Error('Respuesta no válida de Gemini API: ' + response.statusText);
  }

  const data = await response.json();
  const textResponse = data.candidates[0].content.parts[0].text;

  const jsonMatch = textResponse.match(/\[.*\]/s);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  return JSON.parse(textResponse);
}
