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

async function saveClient(client) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clients', 'readwrite');
    const store = tx.objectStore('clients');
    const request = client.id ? store.put(client) : store.add(client);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteClient(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clients', 'readwrite');
    const store = tx.objectStore('clients');
    const request = store.delete(Number(id));
    request.onsuccess = () => resolve(true);
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

async function saveInvoice(invoice) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('invoices', 'readwrite');
    const store = tx.objectStore('invoices');
    // Ensure timestamp
    invoice.updatedAt = new Date().toISOString();
    if (!invoice.createdAt) invoice.createdAt = new Date().toISOString();
    
    const request = invoice.id ? store.put(invoice) : store.add(invoice);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteInvoice(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('invoices', 'readwrite');
    const store = tx.objectStore('invoices');
    const request = store.delete(Number(id));
    request.onsuccess = () => resolve(true);
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

// Carga inicial con algunos clientes de demostración si la BD está vacía
async function seedInitialDataIfEmpty() {
  const clients = await getAllClients();
  if (clients.length === 0) {
    console.log('Inicializando clientes de ejemplo en la agenda...');
    await saveClient({
      name: 'Restaurante El Marisco',
      cif: 'B-29123456',
      address: 'Paseo Marítimo, 12',
      province: 'Málaga',
      phone: '952 555 123'
    });
    await saveClient({
      name: 'Chiringuito Pepe',
      cif: 'A-29876543',
      address: 'Playa de Algarrobo, s/n',
      province: 'Málaga',
      phone: '610 998 877'
    });
  }
}
