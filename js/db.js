/* ==========================================================================
   PESCADERÍA RANA - BASE DE DATOS LOCAL (IndexedDB)
   ========================================================================== */

const DB_NAME = 'PescaderiaRanaDB';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Inicializa IndexedDB con los almacenes de Clientes, Facturas y Configuración.
 */
function initDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Almacén de Clientes
      if (!db.objectStoreNames.contains('clients')) {
        const clientStore = db.createObjectStore('clients', { keyPath: 'id', autoIncrement: true });
        clientStore.createIndex('name', 'name', { unique: false });
        clientStore.createIndex('cif', 'cif', { unique: false });
      }

      // Almacén de Facturas
      if (!db.objectStoreNames.contains('invoices')) {
        const invoiceStore = db.createObjectStore('invoices', { keyPath: 'id', autoIncrement: true });
        invoiceStore.createIndex('number', 'number', { unique: false });
        invoiceStore.createIndex('date', 'date', { unique: false });
        invoiceStore.createIndex('clientName', 'clientName', { unique: false });
      }

      // Almacén de Configuración (Settings)
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      console.log('IndexedDB iniciada correctamente para Pescadería Rana');
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('Error al abrir IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

// ------------------- OPERACIONES CLIENTES -------------------

async function getAllClients() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clients', 'readonly');
    const store = tx.objectStore('clients');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function saveClient(client, opts = {}) {
  const db = await initDB();
  if (!opts.fromSync) client.updatedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clients', 'readwrite');
    const store = tx.objectStore('clients');
    const request = client.id ? store.put(client) : store.add(client);
    request.onsuccess = (e) => {
      if (!opts.fromSync && typeof hookSave === 'function') hookSave('clients', e.target.result);
      resolve(e.target.result);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteClient(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clients', 'readwrite');
    const store = tx.objectStore('clients');
    const request = store.delete(Number(id));
    request.onsuccess = () => {
      if (typeof hookDelete === 'function') hookDelete('clients', Number(id));
      resolve(true);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// ------------------- OPERACIONES FACTURAS -------------------

async function getAllInvoices() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('invoices', 'readonly');
    const store = tx.objectStore('invoices');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function getInvoiceById(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('invoices', 'readonly');
    const store = tx.objectStore('invoices');
    const request = store.get(Number(id));
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function saveInvoice(invoice, opts = {}) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('invoices', 'readwrite');
    const store = tx.objectStore('invoices');
    // Ensure timestamp
    if (!opts.fromSync) invoice.updatedAt = new Date().toISOString();
    if (!invoice.createdAt) invoice.createdAt = new Date().toISOString();
    
    const request = invoice.id ? store.put(invoice) : store.add(invoice);
    request.onsuccess = (e) => {
      if (!opts.fromSync && typeof hookSave === 'function') hookSave('invoices', e.target.result);
      resolve(e.target.result);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteInvoice(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('invoices', 'readwrite');
    const store = tx.objectStore('invoices');
    const request = store.delete(Number(id));
    request.onsuccess = () => {
      if (typeof hookDelete === 'function') hookDelete('invoices', Number(id));
      resolve(true);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// ------------------- CONFIGURACIÓN Y AJUSTES -------------------

async function getSetting(key, defaultValue = null) {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const request = store.get(key);
    request.onsuccess = () => {
      resolve(request.result ? request.result.value : defaultValue);
    };
    request.onerror = () => resolve(defaultValue);
  });
}

async function saveSetting(key, value) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const request = store.put({ key, value });
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

// La agenda nace VACÍA: no se siembran clientes de ejemplo.
// Todo lo que aparezca lo habrá dado de alta el usuario.
