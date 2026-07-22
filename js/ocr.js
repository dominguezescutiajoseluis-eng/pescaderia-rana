/* ==========================================================================
   PESCADERÍA RANA - MOTOR DE ESCANEO OCR E INTELIGENCIA ARTIFICIAL (CON LOTE)
   ========================================================================== */

let selectedImageBase64 = null;
let cameraStream = null;

/**
 * Inicializa los eventos del módulo de escáner OCR y cámara
 */
function initOCRScanner() {
  const fileInput = document.getElementById('camera-file-input');
  const directFileInput = document.getElementById('direct-camera-file-input');
  const btnStartCamera = document.getElementById('btn-start-camera');
  const btnStopCamera = document.getElementById('btn-stop-camera');
  const btnCaptureFrame = document.getElementById('btn-capture-frame');
  const btnProcessOCR = document.getElementById('btn-process-ocr');
  const btnAddScannedToInv = document.getElementById('btn-add-scanned-to-invoice');

  // Evento Selección / Captura por archivo de cámara (Pestaña Escáner)
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleImageSelected(file, false);
    });
  }

  // Evento Selección / Captura directa desde "Añadir Pescado"
  if (directFileInput) {
    directFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleImageSelected(file, true);
    });
  }

  // Eventos de cámara en vivo
  if (btnStartCamera) btnStartCamera.addEventListener('click', startLiveCamera);
  if (btnStopCamera) btnStopCamera.addEventListener('click', stopLiveCamera);
  if (btnCaptureFrame) btnCaptureFrame.addEventListener('click', captureCameraFrame);

  // Botón Analizar Papeleta (Pestaña Escáner)
  if (btnProcessOCR) btnProcessOCR.addEventListener('click', () => runOCRAnalysis(false));

  // Transferir ítems a la factura
  if (btnAddScannedToInv) btnAddScannedToInv.addEventListener('click', transferDetectedItemsToInvoice);
}

/**
 * Procesa la imagen seleccionada o capturada y activa el análisis
 */
function handleImageSelected(fileOrBlob, isDirectInline = false) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    selectedImageBase64 = e.target.result;
    
    if (isDirectInline) {
      // Escaneo directo rápido dentro de la sección Añadir Pescado
      await runDirectInlineOCRAnalysis(selectedImageBase64);
    } else {
      // Escaneo completo en la pestaña de Escáner Avanzado
      const previewImg = document.getElementById('scanned-image-preview');
      if (previewImg) previewImg.src = selectedImageBase64;
      document.getElementById('scanner-preview-container').classList.remove('hidden');
      document.getElementById('btn-process-ocr').disabled = false;
      showToast('Papeleta cargada. Haz clic en Analizar Papeleta.');
    }
  };
  reader.readAsDataURL(fileOrBlob);
}

/**
 * Abre la cámara del dispositivo móvil o PC
 */
async function startLiveCamera() {
  const cameraBox = document.getElementById('live-camera-container');
  const video = document.getElementById('camera-video');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = cameraStream;
    cameraBox.classList.remove('hidden');
  } catch (err) {
    console.error('Error al acceder a la cámara:', err);
    alert('No se pudo acceder a la cámara. Usa la opción de capturar foto / subir archivo.');
  }
}

/**
 * Detiene la cámara en vivo
 */
function stopLiveCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  document.getElementById('live-camera-container').classList.add('hidden');
}

/**
 * Captura un fotograma de la cámara
 */
function captureCameraFrame() {
  const video = document.getElementById('camera-video');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob((blob) => {
    handleImageSelected(blob, true);
    stopLiveCamera();
  }, 'image/jpeg', 0.9);
}

/**
 * Ejecuta el escaneo directo e inserta el Lote, Concepto y Precios inmediatamente en los inputs de "Añadir Pescado"
 */
async function runDirectInlineOCRAnalysis(imageBase64) {
  const loading = document.getElementById('direct-scan-loading');
  const statusText = document.getElementById('direct-scan-status');

  loading.classList.remove('hidden');
  statusText.textContent = 'Analizando número de lote y productos con la IA...';

  try {
    let items = [];
    const apiKey = await getSetting('gemini_api_key', '');

    if (apiKey) {
      items = await processWithGeminiAI(imageBase64);
    } else {
      items = await processWithTesseractLocal(imageBase64);
    }

    if (items && items.length > 0) {
      if (items.length === 1) {
        // Un solo producto: Rellenar directamente el formulario de "Añadir Pescado"
        const first = items[0];
        document.getElementById('item-concept').value = first.concepto || '';
        document.getElementById('item-lote').value = first.lote || extractLoteFromText(first.concepto) || '';
        document.getElementById('item-qty').value = first.cantidad || '';
        document.getElementById('item-price').value = first.precio_kg || '';
        showToast('¡Datos y N° de Lote detectados y rellenados!');
      } else {
        // Múltiples productos: Añadirlos todos directamente a la factura con su Lote
        addItemsToActiveInvoice(items);
        showToast(`Se insertaron ${items.length} productos con sus lotes en la factura`);
      }
    } else {
      alert('No se pudieron leer filas claras. Por favor ingresa el lote y concepto manualmente.');
    }
  } catch (err) {
    console.error('Error en escaneo directo:', err);
    alert('Error leyendo papeleta: ' + err.message);
  } finally {
    loading.classList.add('hidden');
  }
}

/**
 * Ejecuta el análisis OCR o IA desde la pestaña Escáner Avanzado
 */
async function runOCRAnalysis(isDirect = false) {
  if (!selectedImageBase64) return;

  const loading = document.getElementById('ocr-loading');
  const statusText = document.getElementById('ocr-status-text');
  const engine = document.querySelector('input[name="ocr-engine"]:checked').value;

  loading.classList.remove('hidden');
  document.getElementById('btn-process-ocr').disabled = true;

  try {
    let items = [];
    if (engine === 'gemini') {
      statusText.textContent = 'Buscando número de lote y trazabilidad con Agente IA Vision...';
      items = await processWithGeminiAI(selectedImageBase64);
    } else {
      statusText.textContent = 'Procesando con Tesseract OCR local...';
      items = await processWithTesseractLocal(selectedImageBase64);
    }

    renderDetectedItems(items);
    showToast(`Se identificaron ${items.length} productos en la papeleta`);
  } catch (err) {
    console.error('Error en escaneo OCR/IA:', err);
    const fallbackItems = await processWithTesseractLocal(selectedImageBase64);
    renderDetectedItems(fallbackItems);
  } finally {
    loading.classList.add('hidden');
    document.getElementById('btn-process-ocr').disabled = false;
  }
}

/**
 * Procesa la papeleta usando la API de Gemini Vision especificando la captura del N° de Lote
 */
async function processWithGeminiAI(imageBase64) {
  const apiKey = await getSetting('gemini_api_key', '');
  
  if (!apiKey) {
    console.warn('Sin clave de Gemini configurada. Usando analizador local.');
    return await processWithTesseractLocal(imageBase64);
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

/**
 * OCR Local con Tesseract y extractor de Número de Lote
 */
async function processWithTesseractLocal(imageBase64) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('Tesseract.js no está cargado.');
  }

  const result = await Tesseract.recognize(imageBase64, 'spa', {
    logger: m => console.log(m)
  });

  const text = result.data.text;
  console.log('Texto OCR Reconocido:\n', text);

  return parsePapeletaTextToItemsWithLote(text);
}

/**
 * Analizador heurístico para extraer productos y su N° de Lote
 */
function parsePapeletaTextToItemsWithLote(rawText) {
  const lines = rawText.split('\n');
  const detectedItems = [];

  // Buscar si hay un lote global en la papeleta
  const globalLoteMatch = rawText.match(/(?:lote|lot|l-)\s*[:#]?\s*([a-zA-Z0-9-]+)/i);
  const globalLote = globalLoteMatch ? `Lote ${globalLoteMatch[1]}` : '';

  const fishKeywords = ['gamba', 'merluza', 'boqueron', 'boquerón', 'sardina', 'calamar', 'pulpo', 'dorada', 'lubina', 'bacalao', 'lenguado', 'sepia', 'salmon', 'salmón', 'atún', 'atun', 'rape', 'pescadilla', 'cigala', 'langostino', 'almeja', 'coquina', 'pargo', 'corvina', 'gallineta', 'chopo', 'pota'];

  lines.forEach(line => {
    const lower = line.toLowerCase().trim();
    if (!lower) return;

    const hasFish = fishKeywords.some(kw => lower.includes(kw));
    const numbers = lower.match(/(\d+[.,]?\d*)/g);

    if (hasFish || (numbers && numbers.length >= 2)) {
      let qty = 1.0;
      let price = 0.0;

      if (numbers && numbers.length >= 1) qty = parseFloat(numbers[0].replace(',', '.'));
      if (numbers && numbers.length >= 2) price = parseFloat(numbers[1].replace(',', '.'));

      const subtotal = Math.round(qty * price * 100) / 100;

      // Buscar lote específico en la línea
      const lineLoteMatch = line.match(/(?:lote|lot|l-)\s*[:#]?\s*([a-zA-Z0-9-]+)/i);
      const lote = lineLoteMatch ? `Lote ${lineLoteMatch[1]}` : globalLote;

      let concepto = line.replace(/(?:lote|lot|l-)\s*[:#]?\s*[a-zA-Z0-9-]+/gi, '').replace(/[^\w\sáéíóúñÁÉÍÓÚÑ.,#-]/gi, ' ').trim();
      if (!concepto) concepto = 'Pescado fresco de lonja';

      detectedItems.push({
        lote: lote || '',
        cantidad: qty || 1.0,
        concepto: concepto,
        precio_kg: price || 0.0,
        subtotal: subtotal || 0.0
      });
    }
  });

  if (detectedItems.length === 0) {
    detectedItems.push({
      lote: globalLote || 'Lote ' + new Date().toISOString().slice(2,10).replace(/-/g,''),
      cantidad: 1.0,
      concepto: 'Pescado fresco de lonja',
      precio_kg: 0.0,
      subtotal: 0.0
    });
  }

  return detectedItems;
}

/**
 * Busca patrones de lote en un texto libre
 */
function extractLoteFromText(text) {
  if (!text) return '';
  const match = text.match(/(?:lote|lot|l-)\s*[:#]?\s*([a-zA-Z0-9-]+)/i);
  return match ? match[1] : '';
}

/**
 * Renderiza los ítems e incluye el campo del Número de Lote
 */
function renderDetectedItems(items) {
  const container = document.getElementById('detected-items-list');
  const actionsBar = document.getElementById('detected-actions');

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>No se lograron extraer filas automáticamente. Puedes añadir manualmente.</p>
      </div>`;
    actionsBar.classList.add('hidden');
    return;
  }

  let html = '';
  items.forEach((item, index) => {
    html += `
      <div class="detected-item-card" data-index="${index}">
        <div class="form-row">
          <div class="form-group flex-2">
            <label>Concepto / Especie</label>
            <input type="text" class="form-input det-concept" value="${escapeHtml(item.concepto || '')}">
          </div>
          <div class="form-group flex-1">
            <label><i class="fa-solid fa-barcode"></i> N° Lote</label>
            <input type="text" class="form-input det-lote" value="${escapeHtml(item.lote || '')}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Cantidad (Kg)</label>
            <input type="number" step="0.01" class="form-input det-qty" value="${item.cantidad || 1}">
          </div>
          <div class="form-group">
            <label>Precio/Kg (€)</label>
            <input type="number" step="0.01" class="form-input det-price" value="${item.precio_kg || 0}">
          </div>
          <div class="form-group">
            <label>Subtotal (€)</label>
            <input type="number" step="0.01" class="form-input det-subtotal" value="${item.subtotal || 0}" readonly>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  actionsBar.classList.remove('hidden');

  container.querySelectorAll('.detected-item-card').forEach(card => {
    const qtyInput = card.querySelector('.det-qty');
    const priceInput = card.querySelector('.det-price');
    const subtotalInput = card.querySelector('.det-subtotal');

    const updateSub = () => {
      const q = parseFloat(qtyInput.value) || 0;
      const p = parseFloat(priceInput.value) || 0;
      subtotalInput.value = (q * p).toFixed(2);
    };

    qtyInput.addEventListener('input', updateSub);
    priceInput.addEventListener('input', updateSub);
  });
}

/**
 * Transfiere los productos escaneados con su N° de Lote a la factura activa
 */
function transferDetectedItemsToInvoice() {
  const itemCards = document.querySelectorAll('.detected-item-card');
  if (itemCards.length === 0) return;

  const itemsToAdd = [];
  itemCards.forEach(card => {
    const concepto = card.querySelector('.det-concept').value.trim();
    const lote = card.querySelector('.det-lote').value.trim();
    const cantidad = parseFloat(card.querySelector('.det-qty').value) || 0;
    const precio_kg = parseFloat(card.querySelector('.det-price').value) || 0;
    const subtotal = parseFloat(card.querySelector('.det-subtotal').value) || (cantidad * precio_kg);

    if (concepto) {
      itemsToAdd.push({ concepto, lote, cantidad, precio_kg, subtotal });
    }
  });

  if (itemsToAdd.length > 0) {
    addItemsToActiveInvoice(itemsToAdd);
    showToast(`Se añadieron ${itemsToAdd.length} productos con sus lotes a la factura`);
    document.querySelector('.nav-btn[data-tab="invoice-builder"]').click();
  }
}
