/* ==========================================================================
   PESCADERÍA RANA - ENVÍO DE FACTURA POR WHATSAPP (WhatsApp Web)
   - Botón «WhatsApp» en el facturador (envía la factura que se está creando)
   - Botón por cada factura en el Registro de Facturas
   El teléfono se guarda con la factura (campo clientPhone).

   FLUJO PDF: al pulsar se genera el PDF OFICIAL de la factura (el mismo
   documento que se imprime), se DESCARGA en el equipo y se abre WhatsApp Web
   con el resumen escrito. WhatsApp Web no permite adjuntar ficheros por URL
   (seguridad del navegador), así que el PDF se arrastra a la conversación
   o se pulsa el clip 📎 y se elige de Descargas — 2 segundos.
   ========================================================================== */

/** Normaliza un teléfono español al formato internacional 34XXXXXXXXX */
function normalizarTelefonoWhatsApp(telefono) {
  if (!telefono) return '';
  let t = String(telefono).replace(/[^\d+]/g, '');
  if (t.startsWith('00')) t = t.slice(2);
  if (t.startsWith('+')) t = t.slice(1);
  if (t.length === 9) t = '34' + t; // móvil/fijo español sin prefijo
  return t;
}

/** Texto del mensaje con el resumen de la factura */
function construirMensajeFactura(inv) {
  const cfg = window.__companyData || {};
  const empresa = cfg.companyName || 'PESCADERÍA RANA';
  const lineas = (inv.items || []).map(it =>
    `• ${it.concepto} (Lote ${it.lote || '-'}): ${formatNumber(it.cantidad)} kg × ${formatNumber(it.precio_kg)} € = ${formatNumber(it.subtotal)} €`
  ).join('\n');

  return `${empresa} — Factura ${inv.number}\n` +
    `Fecha: ${formatDateDisplay(inv.date)}\n` +
    `Cliente: ${inv.clientName || '-'}\n` +
    `\nProductos:\n${lineas}\n` +
    `\nTOTAL: ${formatNumber(inv.totalFactura)} €` +
    `\n\nAdjunto el PDF con la factura oficial. Gracias por su confianza.`;
}

/** Rellena la zona de impresión (invoice-print-area) con los datos de una
 *  factura concreta. Para la factura en curso vale updateInvoicePreview();
 *  para una del REGISTRO hay que pintarla desde el objeto guardado. */
function rellenarPlantillaDesdeFactura(inv) {
  const pone = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.textContent = valor || '';
  };
  pone('pv-inv-number', inv.number);
  let fecha = '';
  if (inv.date) {
    const p = String(inv.date).split('-');
    fecha = p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : inv.date;
  }
  pone('pv-inv-date', fecha);
  pone('pv-client-name', inv.clientName);
  pone('pv-client-cif', inv.clientCif);
  pone('pv-client-address', inv.clientAddress);
  pone('pv-client-province', inv.clientProvince);
  const tbody = document.getElementById('pv-items-body');
  if (tbody) {
    tbody.innerHTML = '';
    (inv.items || []).forEach(it => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatNumber(it.cantidad)}</td>` +
        `<td>${it.concepto || ''}</td>` +
        `<td>${it.lote || ''}</td>` +
        `<td>${formatNumber(it.precio_kg)} €</td>` +
        `<td>${formatNumber(it.subtotal)} €</td>`;
      tbody.appendChild(tr);
    });
  }
  pone('pv-total-factura', `${formatNumber(inv.totalFactura || 0)} €`);
}

/** Genera el PDF oficial de una factura y lo devuelve como Blob.
 *  Rellena la zona de impresión con los datos de la factura (misma vía que
 *  «Imprimir / PDF»), genera con html2pdf y captura el resultado. */
async function generarPdfFactura(inv) {
  if (typeof html2pdf === 'undefined') {
    throw new Error('El generador de PDF no está disponible.');
  }
  const contenedor = document.getElementById('invoice-print-area');
  if (!contenedor) throw new Error('No encuentro la plantilla de factura.');

  // Factura del formulario en curso: la vista previa ya está bien.
  // Factura del registro: pintar la plantilla desde el objeto guardado.
  if (inv.__desdeRegistro || !document.getElementById('inv-number') || document.getElementById('inv-number').value !== inv.number) {
    rellenarPlantillaDesdeFactura(inv);
  }

  const nombre = `Factura_${String(inv.number).replace(/[\/\\]/g, '-')}_Pescaderia_Rana.pdf`;
  const opt = {
    margin: 10,
    filename: nombre,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };

  const blob = await html2pdf().set(opt).from(contenedor).outputPdf('blob');
  return { blob, nombre };
}

/** Descarga el PDF en el equipo del usuario */
function descargarPdfFactura(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Genera el PDF + abre WhatsApp Web con el mensaje listo */
async function enviarFacturaWhatsApp(inv) {
  if (!inv) return;
  const tel = normalizarTelefonoWhatsApp(inv.clientPhone);
  let pdfInfo = null;
  try {
    showToast('Generando el PDF de la factura…');
    pdfInfo = await generarPdfFactura(inv);
    descargarPdfFactura(pdfInfo.blob, pdfInfo.nombre);
  } catch (err) {
    console.warn('No se pudo generar el PDF, se envía solo el texto:', err);
  }

  const texto = encodeURIComponent(construirMensajeFactura(inv));
  const url = tel
    ? `https://web.whatsapp.com/send?phone=${tel}&text=${texto}`
    : `https://web.whatsapp.com/send?text=${texto}`;
  window.open(url, '_blank');

  if (pdfInfo) {
    showToast(`PDF descargado (${pdfInfo.nombre}). En WhatsApp: 📎 adjuntar o arrastrar el PDF.`);
  } else {
    showToast('Abriendo WhatsApp Web…');
  }
}

/** ---- Botón del facturador (factura actual) ---- */
function initWhatsAppModule() {
  const btn = document.getElementById('btn-whatsapp-invoice');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const number = document.getElementById('inv-number').value.trim();
    const fecha = document.getElementById('inv-date').value;
    const nombre = document.getElementById('inv-client-name').value.trim();
    const cif = document.getElementById('inv-client-cif').value.trim();
    const direccion = document.getElementById('inv-client-address').value.trim();
    const provincia = document.getElementById('inv-client-province').value.trim();
    const telefono = document.getElementById('inv-client-phone').value.trim();

    if (!number) { alert('Introduce el número de factura antes de enviarla.'); return; }
    if (activeInvoiceItems.length === 0) { alert('Añade al menos un producto antes de enviarla.'); return; }

    const factura = {
      number,
      date: fecha,
      clientName: nombre,
      clientCif: cif,
      clientAddress: direccion,
      clientProvince: provincia || 'Málaga',
      clientPhone: telefono,
      items: activeInvoiceItems,
      totalFactura: activeInvoiceItems.reduce((s, i) => s + i.subtotal, 0),
    };

    // Si ya está guardada en el registro, usar la guardada (tiene items confirmados)
    if (editingInvoiceId) {
      const guardada = await getInvoiceById(editingInvoiceId);
      if (guardada) {
        guardada.clientPhone = telefono || guardada.clientPhone;
        return enviarFacturaWhatsApp(guardada);
      }
    }
    enviarFacturaWhatsApp(factura);
  });
}

/** Cargo los datos del emisor para la cabecera del mensaje */
(async () => {
  try {
    window.__companyData = await getSetting('company_data', {});
  } catch (e) { window.__companyData = {}; }
})();
