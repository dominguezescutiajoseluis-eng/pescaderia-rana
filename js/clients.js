/* ==========================================================================
   PESCADERÍA RANA - GESTIÓN DE AGENDA DE CLIENTES
   ========================================================================== */

let clientsList = [];

/**
 * Inicializa los eventos del módulo de clientes
 */
function initClientsModule() {
  const btnOpenModal = document.getElementById('btn-open-client-modal');
  const btnQuickAdd = document.getElementById('btn-quick-add-client');
  const btnCloseModal = document.getElementById('btn-close-client-modal');
  const btnCancelModal = document.getElementById('btn-cancel-client-modal');
  const btnSaveModal = document.getElementById('btn-save-client-modal');
  const searchInput = document.getElementById('client-search-input');
  const clientSelect = document.getElementById('inv-client-select');

  // Abrir Modal
  if (btnOpenModal) btnOpenModal.addEventListener('click', () => openClientModal());
  if (btnQuickAdd) btnQuickAdd.addEventListener('click', () => openClientModal());

  // Cerrar Modal
  if (btnCloseModal) btnCloseModal.addEventListener('click', closeClientModal);
  if (btnCancelModal) btnCancelModal.addEventListener('click', closeClientModal);

  // Guardar Cliente desde Modal
  if (btnSaveModal) btnSaveModal.addEventListener('click', handleSaveClient);

  // Buscar Clientes
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      renderClientsTable(clientsList.filter(c => 
        (c.name && c.name.toLowerCase().includes(term)) ||
        (c.cif && c.cif.toLowerCase().includes(term)) ||
        (c.phone && c.phone.includes(term))
      ));
    });
  }

  // Cambio de selección de cliente en el Facturador
  if (clientSelect) {
    clientSelect.addEventListener('change', (e) => {
      const clientId = e.target.value;
      if (!clientId) return;
      
      const client = clientsList.find(c => String(c.id) === String(clientId));
      if (client) {
        assignClientToInvoice(client);
      }
    });
  }

  // Cargar clientes iniciales
  loadClients();
}

/**
 * Carga la lista de clientes desde IndexedDB
 */
async function loadClients() {
  try {
    clientsList = await getAllClients();
    renderClientsTable(clientsList);
    populateClientSelect(clientsList);
  } catch (err) {
    console.error('Error al cargar agenda de clientes:', err);
  }
}

/**
 * Renderiza la tabla de clientes en la pestaña Agenda
 */
function renderClientsTable(list) {
  const tbody = document.getElementById('clients-table-body');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: #64748b; padding: 2rem;">
          No hay clientes registrados en la agenda. ¡Añade tu primer cliente!
        </td>
      </tr>`;
    return;
  }

  let html = '';
  list.forEach(c => {
    html += `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(c.cif || '-')}</td>
        <td>${escapeHtml(c.address || '-')}</td>
        <td>${escapeHtml(c.province || 'Málaga')}</td>
        <td>${escapeHtml(c.phone || '-')}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="selectClientForInvoice(${c.id})" title="Usar en Factura">
            <i class="fa-solid fa-file-invoice"></i>
          </button>
          <button class="icon-btn" onclick="editClient(${c.id})" title="Editar">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="icon-btn" onclick="confirmDeleteClient(${c.id})" title="Eliminar">
            <i class="fa-solid fa-trash" style="color: #ef4444;"></i>
          </button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

/**
 * Llena el desplegable de clientes en el formulario de la factura
 */
function populateClientSelect(list) {
  const select = document.getElementById('inv-client-select');
  if (!select) return;

  let html = '<option value="">-- Seleccionar de Agenda --</option>';
  list.forEach(c => {
    html += `<option value="${c.id}">${escapeHtml(c.name)} ${c.cif ? '(' + c.cif + ')' : ''}</option>`;
  });
  select.innerHTML = html;
}

/**
 * Abre el modal para crear o editar un cliente
 */
function openClientModal(client = null) {
  const modal = document.getElementById('client-modal');
  const title = document.getElementById('modal-client-title');
  
  document.getElementById('modal-client-id').value = client ? client.id : '';
  document.getElementById('modal-client-name').value = client ? client.name : '';
  document.getElementById('modal-client-cif').value = client ? client.cif || '' : '';
  document.getElementById('modal-client-address').value = client ? client.address || '' : '';
  document.getElementById('modal-client-province').value = client ? client.province || 'Málaga' : 'Málaga';
  document.getElementById('modal-client-phone').value = client ? client.phone || '' : '';

  title.textContent = client ? 'Editar Cliente' : 'Nuevo Cliente Agenda';
  modal.classList.remove('hidden');
}

/**
 * Cierra el modal de clientes
 */
function closeClientModal() {
  document.getElementById('client-modal').classList.add('hidden');
}

/**
 * Procesa el guardado del cliente
 */
async function handleSaveClient() {
  const id = document.getElementById('modal-client-id').value;
  const name = document.getElementById('modal-client-name').value.trim();
  const cif = document.getElementById('modal-client-cif').value.trim();
  const address = document.getElementById('modal-client-address').value.trim();
  const province = document.getElementById('modal-client-province').value.trim();
  const phone = document.getElementById('modal-client-phone').value.trim();

  if (!name) {
    alert('Por favor introduce el Nombre o Razón Social del cliente.');
    return;
  }

  const clientData = {
    name,
    cif,
    address,
    province: province || 'Málaga',
    phone
  };

  if (id) {
    clientData.id = Number(id);
  }

  try {
    await saveClient(clientData);
    showToast(id ? 'Cliente actualizado' : 'Nuevo cliente guardado en agenda');
    closeClientModal();
    await loadClients();
  } catch (err) {
    console.error('Error al guardar cliente:', err);
    alert('Error al guardar el cliente: ' + err.message);
  }
}

/**
 * Prepara la edición de un cliente existente
 */
function editClient(id) {
  const client = clientsList.find(c => c.id === id);
  if (client) {
    openClientModal(client);
  }
}

/**
 * Confirma y elimina un cliente
 */
async function confirmDeleteClient(id) {
  if (confirm('¿Estás seguro de que deseas eliminar este cliente de la agenda?')) {
    try {
      await deleteClient(id);
      showToast('Cliente eliminado de la agenda');
      await loadClients();
    } catch (err) {
      alert('Error al eliminar cliente: ' + err.message);
    }
  }
}

/**
 * Asigna un cliente seleccionado directamente a los campos de la factura activa
 */
function selectClientForInvoice(id) {
  const client = clientsList.find(c => c.id === id);
  if (client) {
    assignClientToInvoice(client);
    showToast(`Cliente "${client.name}" asignado a la factura`);
    // Ir a la pestaña del facturador
    document.querySelector('.nav-btn[data-tab="invoice-builder"]').click();
  }
}

/**
 * Llena los inputs de cliente en el facturador
 */
function assignClientToInvoice(client) {
  document.getElementById('inv-client-name').value = client.name || '';
  document.getElementById('inv-client-cif').value = client.cif || '';
  document.getElementById('inv-client-address').value = client.address || '';
  document.getElementById('inv-client-province').value = client.province || 'Málaga';

  // Actualizar la vista previa de la factura inmediatamente
  if (typeof updateInvoicePreview === 'function') {
    updateInvoicePreview();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
