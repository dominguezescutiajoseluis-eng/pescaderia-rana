/* ==========================================================================
   PESCADERÍA RANA - SINCRONIZACIÓN LOCAL + NUBE (Firestore)
   Los datos SIEMPRE se guardan en este equipo (IndexedDB). Si el usuario
   configura su proyecto de Firebase, además se sincronizan con la nube:
   - Subida: cada cambio local entra en una cola y se envía cuando hay red.
   - Bajada: escucha en directo (onSnapshot) y fusiona con regla
     "gana el cambio más reciente" (comparando updatedAt).
   - Sin conexión: la cola se reintenta automáticamente al volver la red.
   ========================================================================== */

const SYNC_STORE = 'sync';
const SYNC_CONFIG_KEY = 'firebase_config_v1';

let firebaseApp = null;
let firestoreDB = null;
let unsubscribeSnapshots = null;
let onlineHandler = null;
// (unsubscribeSnapshots no se usa: hay un listener por colección)
let syncQueueTimer = null;
let syncEnabled = false;

/** Estado visible en la barra lateral */
function setSyncStatus(texto, modo) {
  const el = document.getElementById('sync-status-indicator');
  if (!el) return;
  el.textContent = texto;
  el.parentElement.classList.toggle('sync-off', modo === 'off');
  el.parentElement.classList.toggle('sync-error', modo === 'error');
}

/** Config guardada en IndexedDB (settings) */
async function getConfigSync() {
  return await getSetting(SYNC_CONFIG_KEY, null);
}

async function saveConfigSync(config) {
  await saveSetting(SYNC_CONFIG_KEY, config);
}

/** Parsea el JSON pegado en Configuración (tolera comillas raras y saltos) */
function parseFirebaseConfig(texto) {
  if (!texto || !texto.trim()) throw new Error('Pega el objeto firebaseConfig de tu proyecto.');
  let t = texto.trim();
  // Si el usuario pega solo las propiedades, envolverlas
  if (!t.startsWith('{')) t = '{' + t + '}';
  let obj;
  try {
    obj = JSON.parse(t);
  } catch (err) {
    // Último intento: quitar posibles claves sin comillas
    const limpio = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    obj = JSON.parse(limpio);
  }
  const obligatorias = ['projectId', 'apiKey', 'appId'];
  const faltan = obligatorias.filter(k => !obj[k]);
  if (faltan.length) throw new Error('Al firebaseConfig le faltan: ' + faltan.join(', '));
  return obj;
}

/** Conecta con Firebase y arranca la sincronización */
let unsubClients = null;
let unsubInvoices = null;

async function connectCloudSync(config) {
  if (typeof firebase === 'undefined') throw new Error('El SDK de Firebase no está disponible.');
  if (firebaseApp) await disconnectCloudSync(false);

  firebaseApp = firebase.initializeApp(config, 'pescaderia-rana-sync');
  firestoreDB = firebaseApp.firestore();
  // Cola de subida local persistente (funciona sin conexión: la envía solo)
  firestoreDB.enablePersistence({ synchronizeTabs: false }).catch(() => {});

  syncEnabled = true;
  if (navigator.onLine) setSyncStatus('Sincronizando con la nube…');
  else setSyncStatus('Sin conexión: se enviará al volver la red');

  // 1) Escucha de bajada: clientes y facturas
  unsubClients = firestoreDB.collection('clients').onSnapshot(snap => {
    procesarBajada('clients', snap);
  }, err => { console.error('Sync clients:', err); setSyncStatus('Error de sincronización', 'error'); });

  unsubInvoices = firestoreDB.collection('invoices').onSnapshot(snap => {
    procesarBajada('invoices', snap);
  }, err => { console.error('Sync invoices:', err); setSyncStatus('Error de sincronización', 'error'); });

  // 2) Sube lo local que aún no esté en la nube
  await subirTodo();

  // 3) Reintentos al recuperar la conexión
  onlineHandler = () => {
    if (syncEnabled && navigator.onLine) {
      setSyncStatus('Sincronizando con la nube…');
      subirTodo();
    }
  };
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', () => { if (syncEnabled) setSyncStatus('Sin conexión: se enviará al volver la red'); });

  setSyncStatus('Modo Nube Activo');
  return true;
}

async function disconnectCloudSync(avisar = true) {
  syncEnabled = false;
  if (unsubClients) { unsubClients(); unsubClients = null; }
  if (unsubInvoices) { unsubInvoices(); unsubInvoices = null; }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
  if (firebaseApp) {
    try { await firebaseApp.delete(); } catch (e) { /* nada */ }
    firebaseApp = null;
    firestoreDB = null;
  }
  setSyncStatus('Modo Solo Equipo');
  if (avisar) showToast('Sincronización con la nube desconectada', 'error');
}

/**
 * Regla: si el documento local es más reciente (updatedAt), gana el local y se
 * re-suben; si el de la nube es más reciente, se guarda en local.
 */
async function procesarBajada(coleccion, snap) {
  if (!syncEnabled) return;
  let cambios = 0;

  for (const doc of snap.docs) {
    const cloud = doc.data();
    if (!cloud) continue;
    const idLocal = Number(doc.id);
    if (isNaN(idLocal)) continue; // los IDs locales son numéricos (autoincrement)

    let local = null;
    if (coleccion === 'clients') local = (await getAllClients()).find(c => c.id === idLocal);
    else local = (await getAllInvoices()).find(i => i.id === idLocal);

    if (!local) {
      // No existe en local: traerlo (cliente nuevo creado en otro dispositivo)
      const copia = { ...cloud, id: idLocal };
      delete copia._syncedAt;
      if (coleccion === 'clients') await saveClient(copia, { fromSync: true });
      else await saveInvoice(copia, { fromSync: true });
      cambios++;
      continue;
    }

    const tLocal = new Date(local.updatedAt || 0).getTime();
    const tCloud = new Date(cloud.updatedAt || 0).getTime();
    if (tCloud > tLocal) {
      const copia = { ...cloud, id: idLocal };
      delete copia._syncedAt;
      if (coleccion === 'clients') await saveClient(copia, { fromSync: true });
      else await saveInvoice(copia, { fromSync: true });
      cambios++;
    } else if (tLocal > tCloud) {
      // El local manda: re-subirlo
      marcarParaSubir(coleccion, idLocal);
    }
  }

  if (cambios > 0) {
    console.log('Sync: ' + cambios + ' documento(s) actualizados desde la nube en ' + coleccion);
    if (coleccion === 'clients') await loadClients();
    else await loadInvoicesHistory();
    if (typeof renderSalesReport === 'function') renderSalesReport();
  }
}

/** Cola de subida (en memoria + refactor al guardar cualquier cosa) */
const colaSubida = { clients: new Set(), invoices: new Set() };

function marcarParaSubir(coleccion, id) {
  if (!syncEnabled) return;
  colaSubida[coleccion].add(id);
  programarSubida();
}

function programarSubida() {
  if (syncQueueTimer) return;
  syncQueueTimer = setTimeout(async () => {
    syncQueueTimer = null;
    await subirCola();
  }, 1500);
}

/** Ganchos: se llaman desde db.js tras cada guardado/borrado local */
function hookSave(coleccion, id) { marcarParaSubir(coleccion, id); }
function hookDelete(coleccion, id) {
  if (!syncEnabled || !firestoreDB) return;
  firestoreDB.collection(coleccion).doc(String(id)).delete().catch(err => console.warn('Sync delete:', err));
}

async function subirTodo() {
  try {
    const clientes = await getAllClients();
    clientes.forEach(c => colaSubida.clients.add(c.id));
    const facturas = await getAllInvoices();
    facturas.forEach(i => colaSubida.invoices.add(i.id));
    await subirCola();
  } catch (err) {
    console.error('Sync inicial:', err);
  }
}

async function subirCola() {
  if (!syncEnabled || !firestoreDB || !navigator.onLine) return;
  try {
    const loteC = [...colaSubida.clients];
    for (const id of loteC) {
      const c = (await getAllClients()).find(x => x.id === id);
      if (c) {
        await firestoreDB.collection('clients').doc(String(id)).set({ ...c, _syncedAt: new Date().toISOString() }, { merge: true });
      }
      colaSubida.clients.delete(id);
    }
    const loteI = [...colaSubida.invoices];
    for (const id of loteI) {
      const i = (await getAllInvoices()).find(x => x.id === id);
      if (i) {
        await firestoreDB.collection('invoices').doc(String(id)).set({ ...i, _syncedAt: new Date().toISOString() }, { merge: true });
      }
      colaSubida.invoices.delete(id);
    }
    setSyncStatus('Modo Nube Activo');
  } catch (err) {
    console.warn('Sync: la subida se reintentará:', err.message);
    programarSubida(); // reintento suave
  }
}

/** ---- UI de Configuración ---- */
async function initSyncUI() {
  const btnConectar = document.getElementById('btn-save-firebase-cfg');
  const area = document.getElementById('cfg-firebase-config');
  if (!btnConectar) return;

  // Aviso de estado
  const estado = document.createElement('p');
  estado.className = 'help-text';
  estado.id = 'sync-status-detail';
  btnConectar.parentElement.appendChild(estado);

  const refrescar = async () => {
    const cfg = await getConfigSync();
    if (cfg && area && !area.value) area.value = JSON.stringify(cfg, null, 2);
    if (cfg) {
      estado.textContent = 'Proyecto conectado: ' + cfg.projectId + ' (los cambios se sincronizan en ambos sentidos). Botón "Desconectar" para volver a modo solo equipo.';
      btnConectar.textContent = 'Reconectar Sincronización';
      let btnBorrar = document.getElementById('btn-disconnect-sync');
      if (!btnBorrar) {
        btnBorrar = document.createElement('button');
        btnBorrar.id = 'btn-disconnect-sync';
        btnBorrar.className = 'btn btn-secondary margin-top-sm';
        btnBorrar.textContent = 'Desconectar Nube';
        btnBorrar.addEventListener('click', async () => {
          await saveConfigSync(null);
          await disconnectCloudSync();
          refrescar();
        });
        btnConectar.parentElement.appendChild(btnBorrar);
      }
    } else {
      estado.textContent = 'Sin nube configurada: los datos viven solo en este equipo (con copia de seguridad exportable).';
      const b = document.getElementById('btn-disconnect-sync');
      if (b) b.remove();
      btnConectar.textContent = 'Conectar e Iniciar Sincronización';
    }
  };

  btnConectar.addEventListener('click', async () => {
    try {
      const cfg = parseFirebaseConfig(area.value);
      await saveConfigSync(cfg);
      await connectCloudSync(cfg);
      showToast('Nube conectada: facturas y clientes se sincronizan');
      refrescar();
    } catch (err) {
      showToast('Firebase: ' + err.message, 'error');
    }
  });

  // Restaurar conexión automática al arrancar (si hay config guardada)
  const cfg = await getConfigSync();
  if (cfg) {
    try {
      await connectCloudSync(cfg);
      console.log('Sync: reconectado a', cfg.projectId);
    } catch (err) {
      console.warn('Sync: no se pudo reconectar:', err.message);
      setSyncStatus('Nube no disponible', 'error');
    }
  } else {
    setSyncStatus('Modo Solo Equipo', 'off');
  }
  refrescar();
}

document.addEventListener('DOMContentLoaded', () => {
  initSyncUI();
});
