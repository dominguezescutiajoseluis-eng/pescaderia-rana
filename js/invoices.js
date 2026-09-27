/* ==========================================================================
   PESCADERÍA RANA - MÓDULO DE FACTURACIÓN Y REGISTRO (CON PANEL DE CONTROL Y COLUMNA LOTE SEPARADA)
   ========================================================================== */

let activeInvoiceItems = [];
let editingInvoiceId = null;
let savedInvoicesList = [];

/**
 * Inicializa los eventos del módulo de facturación y registro
 */
function initInvoicesModule() {
  const btnAddItem = document.getElementById('btn-add-item');
  const btnSaveInvoice = document.getElementById('btn-save-invoice');
  const searchInput = document.getElementById('invoice-search-input');
  const btnExportBackup = document.getElementById('btn-export-backup');
  const btnClearActive = document.getElementById('btn-clear-active-items');

  // Asignar fecha de hoy por defecto al crear factura
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('inv-date').value = today;
  
  // Generar número de factura inicial si está vacío
  generateDefaultInvoiceNumber();

  // Eventos de entrada de datos en tiempo real para actualizar la vista previa
  ['inv-number', 'inv-date', 'inv-client-name', 'inv-client-cif', 'inv-client-address', 'inv-client-province'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateInvoicePreview);
  });

  // Botón Añadir Ítem Manual
  if (btnAddItem) {
    btnAddItem.addEventListener('click', handleAddItemFromForm);
  }

  // Botón Vaciar Productos Añadidos
  if (btnClearActive) {
    btnClearActive.addEventListener('click', () => {
      if (activeInvoiceItems.length > 0 && confirm('¿Deseas vaciar todos los productos añadidos a esta factura?')) {
        activeInvoiceItems = [];
        updateInvoicePreview();
        showToast('Lista de productos vaciada');
      }
    });
  }

  // Botón Guardar Factura
  if (btnSaveInvoice) {
    btnSaveInvoice.addEventListener('click', handleSaveInvoice);
  }

  // Búsqueda en historial de facturas
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      renderInvoicesHistory(savedInvoicesList.filter(inv =>
        (inv.number && String(inv.number).toLowerCase().includes(term)) ||
        (inv.clientName && inv.clientName.toLowerCase().includes(term)) ||
        (inv.clientCif && inv.clientCif.toLowerCase().includes(term)) ||
        (inv.date && inv.date.includes(term))
      ));
    });
  }

  // Exportar copia de seguridad JSON
  if (btnExportBackup) {
    btnExportBackup.addEventListener('click', exportDatabaseBackup);
  }

  // Actualizar vista previa inicial
  updateInvoicePreview();
  loadInvoicesHistory();
}

/**
 * Número de factura AUTOMÁTICO estilo 2026/01:
 * - Año en curso + correlativo de dos dígitos según la última guardada.
 * - Nuevo año → vuelve a 01. El usuario puede cambiarlo a mano (se validará
 *   que no esté repetido al guardar).
 */
async function generateDefaultInvoiceNumber() {
  try {
    const anio = new Date().getFullYear();
    const invoices = await getAllInvoices();
    let maximo = 0;
    invoices.forEach(inv => {
      const m = String(inv.number || '').match(/^(\d{4})\/(\d{1,4})$/);
      if (m && Number(m[1]) === anio) {
        maximo = Math.max(maximo, Number(m[2]));
      }
    });
    const siguiente = String(maximo + 1).padStart(2, '0');
    document.getElementById('inv-number').value = anio + '/' + siguiente;
    updateInvoicePreview();
  } catch (err) {
    console.error('Error calculando número de factura:', err);
  }
}

/**
 * Añade un producto / ítem con su N° de Lote desde el formulario del facturador
 */
function handleAddItemFromForm() {
  const conceptInput = document.getElementById('item-concept');
  const loteInput = document.getElementById('item-lote');
  const qtyInput = document.getElementById('item-qty');
  const priceInput = document.getElementById('item-price');

  const concepto = conceptInput.value.trim();
  const lote = loteInput ? loteInput.value.trim() : '';
  const cantidad = parseFloat(qtyInput.value) || 0;
  const precio_kg = parseFloat(priceInput.value) || 0;

  if (!concepto) {
    alert('Por favor introduce la especie o concepto del pescado.');
    return;
  }

  const subtotal = Math.round(cantidad * precio_kg * 100) / 100;

  activeInvoiceItems.push({
    concepto,
    lote,
    cantidad,
    precio_kg,
    subtotal
  });

  // Limpiar campos de entrada
  conceptInput.value = '';
  if (loteInput) loteInput.value = '';
  qtyInput.value = '';
  priceInput.value = '';

  updateInvoicePreview();
  showToast('Producto y N° de Lote añadidos a la factura');
}

/**
 * Agrega múltiples ítems transferidos desde el escáner OCR incorporando el Lote
 */
function addItemsToActiveInvoice(items) {
  items.forEach(item => {
    const concepto = item.concepto || 'Pescado fresco de lonja';
    const lote = item.lote || '';
    const cantidad = parseFloat(item.cantidad) || 0;
    const precio_kg = parseFloat(item.precio_kg) || 0;
    const subtotal = parseFloat(item.subtotal) || Math.round(cantidad * precio_kg * 100) / 100;

    activeInvoiceItems.push({
      concepto,
      lote,
      cantidad,
      precio_kg,
      subtotal
    });
  });
  updateInvoicePreview();
}

/**
 * Elimina una línea de la factura activa por su índice
 */
function removeInvoiceItem(index) {
  const it = activeInvoiceItems[index];
  if (!it) return;
  if (!confirm('¿Quitar "' + it.concepto + '" de la factura?')) return;
  activeInvoiceItems.splice(index, 1);
  updateInvoicePreview();
  showToast('Producto quitado de la factura');
}

/**
 * Carga una línea en el formulario para editarla (la quita de la lista;
 * al pulsar «Añadir Producto» vuelve con los datos corregidos)
 */
function editarItemFactura(index) {
  const it = activeInvoiceItems[index];
  if (!it) return;
  document.getElementById('item-concept').value = it.concepto || '';
  const loteInput = document.getElementById('item-lote');
  if (loteInput) loteInput.value = it.lote || '';
  document.getElementById('item-qty').value = it.cantidad || '';
  document.getElementById('item-price').value = it.precio_kg || '';
  activeInvoiceItems.splice(index, 1);
  updateInvoicePreview();
  document.getElementById('item-concept').focus();
  showToast('Editando: pulsa «Añadir Producto» para guardar los cambios');
}

/**
 * Actualiza la interfaz del formulario (Panel de Control de Productos Añadidos)
 * y la vista previa del documento oficial (Sin columna de Acción y con columna LOTE separada)
 */
function updateInvoicePreview() {
  const number = document.getElementById('inv-number').value || '';
  const dateStr = document.getElementById('inv-date').value;
  const clientName = document.getElementById('inv-client-name').value || '';
  const clientCif = document.getElementById('inv-client-cif').value || '';
  const clientAddress = document.getElementById('inv-client-address').value || '';
  const clientProvince = document.getElementById('inv-client-province').value || 'Málaga';

  let formattedDate = '';
  if (dateStr) {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
  }

  // 1. Metadatos de la cabecera
  document.getElementById('pv-inv-number').textContent = number;
  document.getElementById('pv-inv-date').textContent = formattedDate;
  document.getElementById('pv-client-name').textContent = clientName;
  document.getElementById('pv-client-cif').textContent = clientCif;
  document.getElementById('pv-client-address').textContent = clientAddress;
  document.getElementById('pv-client-province').textContent = clientProvince;

  // 2. RENDERIZAR PANEL DE CONTROL INTERACTIVO EN EL FORMULARIO (Arriba de Añadir Pescado)
  const itemsCountEl = document.getElementById('active-items-count');
  const panelContainer = document.getElementById('active-items-list-container');
  if (itemsCountEl) itemsCountEl.textContent = activeInvoiceItems.length;

  if (panelContainer) {
    if (activeInvoiceItems.length === 0) {
      panelContainer.innerHTML = `
        <div class="empty-panel-msg">
          <i class="fa-solid fa-basket-shopping"></i>
          <span>No hay productos añadidos aún. Escanea una papeleta o introduce los datos abajo.</span>
        </div>`;
    } else {
      let panelHtml = '';
      activeInvoiceItems.forEach((item, index) => {
        panelHtml += `
          <div class="active-item-card">
            <div class="item-main-info">
              <strong>${escapeHtml(item.concepto)}</strong>
              ${item.lote ? `<span class="item-lote-badge"><i class="fa-solid fa-barcode"></i> Lote: ${escapeHtml(item.lote)}</span>` : ''}
            </div>
            <div class="item-numbers-info">
              <span>${formatNumber(item.cantidad)} kg x ${formatNumber(item.precio_kg)} €</span>
              <strong class="item-subtotal-val">${formatNumber(item.subtotal)} €</strong>
            </div>
            <div class="item-actions">
              <button class="icon-btn" onclick="editarItemFactura(${index})" title="Editar este producto">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button class="icon-btn text-danger" onclick="removeInvoiceItem(${index})" title="Eliminar este producto">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
        `;
      });
      panelContainer.innerHTML = panelHtml;
    }
  }

  // 3. RENDERIZAR DOCUMENTO OFICIAL (Sin botones de acción, con columna LOTE separada)
  const tbody = document.getElementById('pv-items-body');
  let itemsHtml = '';
  let totalFactura = 0;

  if (activeInvoiceItems.length === 0) {
    itemsHtml = `
      <tr>
        <td colspan="5" style="text-align: center; color: #94a3b8; font-style: italic; padding: 1.5rem;">
          No hay productos agregados a esta factura.
        </td>
      </tr>`;
  } else {
    activeInvoiceItems.forEach((item) => {
      totalFactura += item.subtotal;
      
      itemsHtml += `
        <tr>
          <td class="col-qty">${formatNumber(item.cantidad)}</td>
          <td class="col-concept">${escapeHtml(item.concepto)}</td>
          <td class="col-lote">${escapeHtml(item.lote || '-')}</td>
          <td class="col-price">${formatNumber(item.precio_kg)} €</td>
          <td class="col-subtotal">${formatNumber(item.subtotal)} €</td>
        </tr>
      `;
    });
  }

  tbody.innerHTML = itemsHtml;
  document.getElementById('pv-total-factura').textContent = `${formatNumber(totalFactura)} €`;
}

/**
 * Guarda la factura activa en IndexedDB
 */
async function handleSaveInvoice() {
  const number = document.getElementById('inv-number').value.trim();
  const date = document.getElementById('inv-date').value;
  const clientName = document.getElementById('inv-client-name').value.trim();
  const clientCif = document.getElementById('inv-client-cif').value.trim();
  const clientAddress = document.getElementById('inv-client-address').value.trim();
  const clientProvince = document.getElementById('inv-client-province').value.trim();

  if (!number) {
    alert('Por favor introduce el número de factura.');
    return;
  }

  if (activeInvoiceItems.length === 0) {
    alert('No puedes guardar una factura vacía. Añade al menos un producto.');
    return;
  }

  const totalFactura = activeInvoiceItems.reduce((sum, item) => sum + item.subtotal, 0);

  const invoiceData = {
    number,
    date,
    clientName,
    clientCif,
    clientAddress,
    clientProvince: clientProvince || 'Málaga',
    clientPhone: document.getElementById('inv-client-phone') ? document.getElementById('inv-client-phone').value.trim() : '',
    items: activeInvoiceItems,
    totalFactura
  };

  // Sin duplicados: si el número ya existe en OTRA factura, avisar
  const todas = await getAllInvoices();
  const repetida = todas.find(inv =>
    String(inv.number).toLowerCase() === String(number).toLowerCase() &&
    (!editingInvoiceId || inv.id !== Number(editingInvoiceId))
  );
  if (repetida) {
    alert('Ya existe una factura con el número ' + number + ' (cliente: ' + (repetida.clientName || '-') + ').\nUsa otro número o edita la existente desde el Registro de Facturas.');
    return;
  }

  if (editingInvoiceId) {
    invoiceData.id = Number(editingInvoiceId);
  }

  try {
    await saveInvoice(invoiceData);
    showToast(editingInvoiceId ? 'Factura actualizada con éxito' : 'Factura guardada en el registro');
    
    resetInvoiceForm();
    await loadInvoicesHistory();
  } catch (err) {
    console.error('Error al guardar factura:', err);
    alert('Error al guardar la factura: ' + err.message);
  }
}

/**
 * Resetea el formulario del facturador
 */
function resetInvoiceForm() {
  editingInvoiceId = null;
  activeInvoiceItems = [];
  document.getElementById('inv-client-name').value = '';
  document.getElementById('inv-client-cif').value = '';
  document.getElementById('inv-client-address').value = '';
  document.getElementById('inv-client-province').value = 'Málaga';
  document.getElementById('inv-client-select').value = '';
  const telInput = document.getElementById('inv-client-phone');
  if (telInput) telInput.value = '';
  const loteInput = document.getElementById('item-lote');
  if (loteInput) loteInput.value = '';
  generateDefaultInvoiceNumber();
}

/**
 * Carga el registro de facturas desde la BD y las renderiza
 */
async function loadInvoicesHistory() {
  try {
    savedInvoicesList = await getAllInvoices();
    savedInvoicesList.sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));
    renderInvoicesHistory(savedInvoicesList);
  } catch (err) {
    console.error('Error al cargar historial de facturas:', err);
  }
}

/**
 * Renderiza la lista de facturas en la tabla de registro
 */
function renderInvoicesHistory(list) {
  const tbody = document.getElementById('invoices-table-body');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: #64748b; padding: 2rem;">
          No hay facturas registradas. ¡Crea y guarda tu primera factura!
        </td>
      </tr>`;
    return;
  }

  let html = '';
  list.forEach(inv => {
    html += `
      <tr>
        <td><strong>${escapeHtml(inv.number)}</strong></td>
        <td>${formatDateDisplay(inv.date)}</td>
        <td>${escapeHtml(inv.clientName || 'Cliente Ocasional')}</td>
        <td>${escapeHtml(inv.clientCif || '-')}</td>
        <td><strong>${formatNumber(inv.totalFactura)} €</strong></td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="editInvoiceInBuilder(${inv.id})" title="Editar Factura">
            <i class="fa-solid fa-pen-to-square"></i> Editar
          </button>
          <button class="btn btn-success btn-sm" onclick="printInvoiceFromHistory(${inv.id})" title="Imprimir / PDF">
            <i class="fa-solid fa-print"></i> PDF
          </button>
          <button class="btn btn-sm btn-whatsapp" onclick="whatsappDesdeRegistro(${inv.id})" title="Enviar por WhatsApp Web">
            <i class="fa-brands fa-whatsapp"></i>
          </button>
          <button class="icon-btn" onclick="confirmDeleteInvoice(${inv.id})" title="Eliminar Factura">
            <i class="fa-solid fa-trash" style="color: #ef4444;"></i>
          </button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

/**
 * Envía por WhatsApp una factura guardada en el registro
 */
async function whatsappDesdeRegistro(id) {
  const inv = await getInvoiceById(id);
  if (inv) enviarFacturaWhatsApp(inv);
}

/**
 * Carga una factura del historial en el editor para modificación
 */
async function editInvoiceInBuilder(id) {
  try {
    const inv = await getInvoiceById(id);
    if (!inv) return;

    editingInvoiceId = inv.id;
    document.getElementById('inv-number').value = inv.number || '';
    document.getElementById('inv-date').value = inv.date || '';
    document.getElementById('inv-client-name').value = inv.clientName || '';
    document.getElementById('inv-client-cif').value = inv.clientCif || '';
    document.getElementById('inv-client-address').value = inv.clientAddress || '';
    document.getElementById('inv-client-province').value = inv.clientProvince || 'Málaga';
    const telInput = document.getElementById('inv-client-phone');
    if (telInput) telInput.value = inv.clientPhone || '';

    activeInvoiceItems = inv.items || [];
    updateInvoicePreview();

    showToast(`Cargada la factura Nº ${inv.number} para editar`);
    document.querySelector('.nav-btn[data-tab="invoice-builder"]').click();
  } catch (err) {
    alert('Error al cargar la factura: ' + err.message);
  }
}

/**
 * Elimina una factura del registro
 */
async function confirmDeleteInvoice(id) {
  try {
    const inv = await getInvoiceById(id);
    if (!inv) return;
    const items = (inv.items || []).length;
    const mensaje = '¿ELIMINAR la factura Nº ' + inv.number + '?\n\n' +
      'Cliente: ' + (inv.clientName || '-') + '\n' +
      'Fecha: ' + formatDateDisplay(inv.date) + '\n' +
      'Productos: ' + items + '\n' +
      'Total: ' + formatNumber(inv.totalFactura) + ' €\n\n' +
      'Esta acción no se puede deshacer (la copia de seguridad es lo único que podría recuperarla).';
    if (!confirm(mensaje)) return;
    await deleteInvoice(id);
    showToast('Factura Nº ' + inv.number + ' eliminada');
    await loadInvoicesHistory();
    if (typeof renderSalesReport === 'function') renderSalesReport();
  } catch (err) {
    alert('Error al eliminar factura: ' + err.message);
  }
}

/**
 * Descarga una copia de seguridad JSON completa de los datos
 */
async function exportDatabaseBackup() {
  try {
    const clients = await getAllClients();
    const invoices = await getAllInvoices();

    const data = {
      app: 'Pescadería Rana - Trazabilidad',
      exportedAt: new Date().toISOString(),
      clients,
      invoices
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `copia_pescaderia_rana_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Copia de seguridad descargada correctamente');
  } catch (err) {
    alert('Error al exportar datos: ' + err.message);
  }
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0,00';
  return Number(num).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return dateStr;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
