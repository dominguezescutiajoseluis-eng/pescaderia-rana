/**
 * Pescadería Rana — puente del envoltorio de escritorio.
 * Marca la página como «app de escritorio» (window.ES_ESCRITORIO = true) para
 * que no registre un service worker: en Electron los ficheros ya son locales y
 * el service worker no aporta nada (además, actualizarlo hacía caer el motor
 * de Chromium de Electron 44 y dejaba el perfil con una caché vieja).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ES_ESCRITORIO', true);

// Puente móvil: iniciar sesión (URL para el QR) y recibir fotos del móvil
contextBridge.exposeInMainWorld('puenteMovil', {
    iniciar: () => ipcRenderer.invoke('puente-movil-iniciar'),
    alRecibirFoto: (callback) => ipcRenderer.on('puente-foto', (_e, dataUrl) => callback(dataUrl)),
});

// Clave de IA dejada de fábrica (gemini-key.txt en la carpeta de la app): el
// proceso principal la entrega una sola vez y la app la guarda en Configuración.
contextBridge.exposeInMainWorld('claveIAFabrica', () => ipcRenderer.invoke('clave-ia-fabrica'));
