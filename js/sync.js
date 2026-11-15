/* ==========================================================================
   PESCADERÍA RANA - SINCRONIZACIÓN LOCAL + NUBE (Firestore)
   Los datos SIEMPRE se guardan en este equipo (IndexedDB). Si el usuario
   conecta su proyecto de Firebase y entra con su cuenta de Google, además se
   sincronizan con la nube, y solo esa cuenta puede leerlos o cambiarlos:
   - Subida: cada cambio local entra en una cola y se envía cuando hay red.
   - Bajada: escucha en directo (onSnapshot) y fusiona con regla
     "gana el cambio más reciente" (comparando updatedAt).
   - Sin conexión: la cola se reintenta automáticamente al volver la red.
   ========================================================================== */

const SYNC_STORE = 'sync';
const SYNC_CONFIG_KEY = 'firebase_config_v1';
const SYNC_SUBIDA_INICIAL_KEY = 'sync_subida_inicial_hecha';
const SYNC_APP_NAME = 'pescaderia-rana-sync';

let firebaseApp = null;
let firestoreDB = null;
let authInst = null;
let authUnsub = null;
let syncConfig = null;
let unsubClients = null;
let unsubInvoices = null;
let onlineHandler = null;
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

/* -------------------------------------------------------------------------
   Cuenta de Google
   ------------------------------------------------------------------------- */

/** Pinta el estado de la sesión en la tarjeta de Configuración */
function mostrarCuenta(user) {
  const caja = document.getElementById('google-cuenta');
  const sesion = document.getElementById('google-sesion');
  const btnEntrar = document.getElementById('btn-google-signin');
  const email = document.getElementById('google-user-email');
  const uid = document.getElementById('google-uid');
  const detalle = document.getElementById('sync-status-detail');
  if (!caja) return;

  caja.classList.toggle('hidden', !syncConfig);

  if (user) {
    if (sesion) sesion.classList.remove('hidden');
    if (btnEntrar) btnEntrar.classList.add('hidden');
    if (email) email.textContent = user.email || 'Cuenta de Google';
    if (uid) uid.textContent = 'UID para las reglas de Firestore: ' + user.uid;
    if (detalle) detalle.textContent = 'Conectado como ' + (user.email || 'tu cuenta de Google') + '.';
  } else {
    if (sesion) sesion.classList.add('hidden');
    if (btnEntrar) btnEntrar.classList.remove('hidden');
    if (uid) uid.textContent = '';
    if (detalle) {
      detalle.textContent = syncConfig
        ? 'Entra con tu cuenta de Google: solo esa cuenta podrá leer o escribir tus facturas.'
        : 'Sin nube configurada: los datos viven solo en este equipo (con copia de seguridad exportable).';
    }
  }
}

/** Traduce los errores de Google/Firebase a algo legible en el mostrador */
function mensajeErrorGoogle(err) {
  const codigo = err && err.code ? String(err.code) : '';
  const mensajes = {
    'auth/popup-closed-by-user': 'Se cerró la ventana de Google antes de terminar.',
    'auth/cancelled-popup-request': 'Se canceló el acceso con Google.',
    'auth/popup-blocked': 'El navegador bloqueó la ventana de Google: permite las ventanas emergentes para este sitio.',
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).',
    'auth/operation-not-allowed': 'El acceso con Google no está activado en Firebase (Authentication → Sign-in method).',
    'auth/network-request-failed': 'Sin conexión con Google. Inténtalo cuando vuelva la red.',
    'auth/configuration-not-found': 'El proyecto de Firebase no tiene Authentication configurado.',
    'auth/internal-error': 'Google devolvió un error interno. Cierra y vuelve a abrir la ventana de acceso.'
  };
  return mensajes[codigo] || (err && err.message) || 'No se pudo completar el acceso con Google.';
}

/** Arranca Firebase (app + auth) y deja la escucha de la sesión */
async function iniciarFirebase(config) {
  if (typeof firebase === 'undefined') throw new Error('El SDK de Firebase no está disponible.');
  if (!firebase.auth) throw new Error('Falta el SDK de autenticación: recarga la página para coger la versión nueva.');

  if (firebaseApp && syncConfig && config && firebaseApp.options && firebaseApp.options.projectId === config.projectId) {
    return true; // ya arrancado con este proyecto
  }

  await cerrarFirebase();

  syncConfig = config;
  firebaseApp = firebase.initializeApp(config, SYNC_APP_NAME);
  authInst = firebaseApp.auth();

  authUnsub = authInst.onAuthStateChanged(async (user) => {
    mostrarCuenta(user);
    if (user) {
      try {
        await activarSincronizacion();
      } catch (err) {
        console.error('Sync:', err);
        setSyncStatus('Error de sincronización', 'error');
      }
    } else {
      detenerSincronizacion();
      setSyncStatus('Conecta tu cuenta de Google', 'off');
    }
  });

  mostrarCuenta(authInst.currentUser || null);
  return true;
}

/** Acceso con la cuenta de Google (ventana o redirección si está bloqueada) */
async function entrarConGoogle() {
  if (!authInst) throw new Error('Primero guarda la configuración de Firebase.');
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const res = await authInst.signInWithPopup(provider);
    return res && res.user ? res.user : null;
  } catch (err) {
    if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment')) {
      await authInst.signInWithRedirect(provider);
      return null;
    }
    throw err;
  }
}

async function salirDeGoogle() {
  if (!authInst) return;
  await authInst.signOut();
  setSyncStatus('Conecta tu cuenta de Google', 'off');
}

/** Apaga listeners, app y sesión */
async function cerrarFirebase() {
  detenerSincronizacion();
  if (authUnsub) { authUnsub(); authUnsub = null; }
  authInst = null;
  if (firebaseApp) {
    try { await firebaseApp.delete(); } catch (e) { /* nada */ }
  }
  firebaseApp = null;
  firestoreDB = null;
  if (syncQueueTimer) { clearTimeout(syncQueueTimer); syncQueueTimer = null; }
}

/* -------------------------------------------------------------------------
   Sincronización
   ------------------------------------------------------------------------- */

async function activarSincronizacion() {
  if (!firebaseApp) throw new Error('Firebase no está arrancado.');
  if (syncEnabled) return;
  if (typeof firebase.firestore !== 'function') throw new Error('El SDK de Firestore no está disponible.');

  firestoreDB = firebaseApp.firestore();
  // Cola de subida local persistente (funciona sin conexión: la envía solo)
  firestoreDB.enablePersistence({ synchronizeTabs: false }).catch(() => {});

  syncEnabled = true;
  setSyncStatus(navigator.onLine ? 'Sincronizando con la nube…' : 'Sin conexión: se enviará al volver la red');

  // 1) Escucha de bajada: clientes y facturas
  unsubClients = firestoreDB.collection('clients').onSnapshot(snap => {
    procesarBajada('clients', snap).catch(err => console.warn('Sync clients:', err));
  }, err => { console.error('Sync clients:', err); setSyncStatus('Error de sincronización', 'error'); });

  unsubInvoices = firestoreDB.collection('invoices').onSnapshot(snap => {
    procesarBajada('invoices', snap).catch(err => console.warn('Sync invoices:', err));
  }, err => { console.error('Sync invoices:', err); setSyncStatus('Error de sincronización', 'error'); });

  // 2) Sube lo local que aún no esté en la nube (solo la primera vez por equipo)
  await subirTodo();

  // 3) Reintentos al recuperar la conexión
  onlineHandler = () => {
    if (syncEnabled && navigator.onLine) {
      setSyncStatus('Sincronizando con la nube…');
      subirCola();
    }
  };
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', () => { if (syncEnabled) setSyncStatus('Sin conexión: se enviará al volver la red'); });

  const email = authInst && authInst.currentUser ? authInst.currentUser.email : 'tu cuenta';
  setSyncStatus('Nube activa: ' + email);
}

function detenerSincronizacion() {
  syncEnabled = false;
  if (unsubClients) { unsubClients(); unsubClients = null; }
  if (unsubInvoices) { unsubInvoices(); unsubInvoices = null; }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
  firestoreDB = null;
}

/** Alias histórico: conectar la nube ahora pasa por el login de Google */
async function connectCloudSync(config) {
  return iniciarFirebase(config);
}

async function disconnectCloudSync(avisar = true) {
  await cerrarFirebase();
  syncConfig = null;
  await saveConfigSync(null);
  const caja = document.getElementById('google-cuenta');
  if (caja) caja.classList.add('hidden');
  const btnDesconectar = document.getElementById('btn-disconnect-sync');
  if (btnDesconectar) btnDesconectar.classList.add('hidden');
  setSyncStatus('Modo Solo Equipo', 'off');
  await mostrarCuenta(null);
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

  // Lo que existe en este equipo y no en la nube se sube (por si quedó pendiente)
  const idsNube = new Set(snap.docs.map(d => String(d.id)));
  const locales = coleccion === 'clients' ? await getAllClients() : await getAllInvoices();
  locales.forEach(doc => { if (!idsNube.has(String(doc.id))) marcarParaSubir(coleccion, doc.id); });

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

/**
 * Subida inicial de todo lo local. Se hace UNA vez por equipo (bandera en
 * settings): así no se reescriben miles de documentos en cada arranque, que
 * gastaría la cuota diaria de Firestore sin necesidad.
 */
async function subirTodo() {
  try {
    if (await getSetting(SYNC_SUBIDA_INICIAL_KEY, false)) return;
    const clientes = await getAllClients();
    clientes.forEach(c => colaSubida.clients.add(c.id));
    const facturas = await getAllInvoices();
    facturas.forEach(i => colaSubida.invoices.add(i.id));
    await subirCola();
    await saveSetting(SYNC_SUBIDA_INICIAL_KEY, true);
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
    const email = authInst && authInst.currentUser ? authInst.currentUser.email : 'tu cuenta';
    setSyncStatus('Nube activa: ' + email);
  } catch (err) {
    console.warn('Sync: la subida se reintentará:', err.message);
    programarSubida(); // reintento suave
  }
}

/* -------------------------------------------------------------------------
   UI de Configuración
   ------------------------------------------------------------------------- */

async function initSyncUI() {
  const btnConectar = document.getElementById('btn-save-firebase-cfg');
  const area = document.getElementById('cfg-firebase-config');
  if (!btnConectar) return;

  const btnEntrar = document.getElementById('btn-google-signin');
  const btnSalir = document.getElementById('btn-google-signout');
  const btnDesconectar = document.getElementById('btn-disconnect-sync');

  const refrescar = async () => {
    const cfg = await getConfigSync();
    if (cfg && area && !area.value) area.value = JSON.stringify(cfg, null, 2);
    const caja = document.getElementById('google-cuenta');
    if (caja) caja.classList.toggle('hidden', !cfg);
    if (btnDesconectar) btnDesconectar.classList.toggle('hidden', !cfg);
    btnConectar.textContent = cfg ? 'Reconectar Sincronización' : 'Guardar configuración';
    if (!cfg) await mostrarCuenta(null);
  };

  btnConectar.addEventListener('click', async () => {
    try {
      const cfg = parseFirebaseConfig(area.value);
      await saveConfigSync(cfg);
      await iniciarFirebase(cfg);
      await refrescar();
      mostrarCuenta(authInst ? authInst.currentUser : null);
      if (!authInst || !authInst.currentUser) {
        showToast('Configuración guardada. Ahora entra con tu cuenta de Google.', 'error');
      } else {
        showToast('Nube conectada con ' + authInst.currentUser.email);
      }
    } catch (err) {
      showToast('Firebase: ' + (err && err.message ? err.message : err), 'error');
    }
  });

  if (btnEntrar) {
    btnEntrar.addEventListener('click', async () => {
      try {
        const user = await entrarConGoogle();
        if (user) showToast('Conectado como ' + (user.email || 'tu cuenta de Google'));
      } catch (err) {
        showToast('Google: ' + mensajeErrorGoogle(err), 'error');
      }
    });
  }

  if (btnSalir) {
    btnSalir.addEventListener('click', async () => {
      try {
        await salirDeGoogle();
        showToast('Sesión de Google cerrada', 'error');
      } catch (err) {
        showToast('Google: ' + mensajeErrorGoogle(err), 'error');
      }
    });
  }

  if (btnDesconectar) {
    btnDesconectar.addEventListener('click', async () => {
      await disconnectCloudSync();
      await refrescar();
    });
  }

  // Restaurar la conexión automática al arrancar (si hay config guardada)
  const cfg = await getConfigSync();
  if (cfg) {
    try {
      await iniciarFirebase(cfg);
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
