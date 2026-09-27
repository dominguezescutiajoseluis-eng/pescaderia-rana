# Pescadería Rana — Trazabilidad y Facturación

Web-app de facturación para Pescadería Rana (desplegada en Render) y base de
la aplicación de escritorio para Linux Mint.

## Novedades de esta versión

- **Todo local, sin CDNs**: tipografías (Inter/Outfit), iconos (Font Awesome
  6.7.2), generador de PDF (html2pdf), SDK de Firebase y motor OCR (Tesseract
  con el español) van en `vendor/`. La app funciona sin conexión.
- **OCR del nº de lote**: botón 📷 junto al campo «N° Lote (trazabilidad)».
  Toma una foto de la papeleta y rellena el número solo, con preprocesado de
  imagen y % de confianza. Si hay clave de Gemini en Configuración, se usa la
  IA antes que el OCR local.
- **Resumen de Ventas funcional**: `js/reports.js` (faltaba en el repositorio)
  con períodos semana/mes/trimestre/semestre/año y desglose por cliente.
- **Local + nube**: los datos siempre en el dispositivo (IndexedDB) y,
  opcionalmente, sincronizados con Firebase Firestore (pegando el
  `firebaseConfig` en Configuración). Bidireccional, con cola sin conexión y
  regla «gana el cambio más reciente».
- **Agenda sin datos de ejemplo**: empieza vacía; nada predefinido.

## Versión de escritorio (Linux Mint)

Del mismo código se genera `pescaderia-rana-facturador_1.0.0_amd64.deb`
(Electron, sin conexión, con el mismo OCR y sincronización). Ver
`escritorio/` en el proyecto de construcción.

## Desarrollo local

```bash
python server.py        # o cualquier servidor estático
# abrir http://localhost:8000
```
