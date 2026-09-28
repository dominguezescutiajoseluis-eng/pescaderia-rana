# Pescadería Rana — Facturador para Linux Mint

La misma aplicación que `https://pescaderia-rana.onrender.com/`, pero instalada
en el equipo: **funciona sin conexión** (todo va dentro del paquete: tipografías,
iconos, motor PDF y el OCR con el español).

## Instalación (una sola vez)

```bash
sudo apt install ./pescaderia-rana-facturador_1.0.0_amd64.deb
```

Después aparece en el menú como **«Pescadería Rana Facturador»** (categoría
Oficina). También puedes lanzarla desde terminal con `pescaderia-rana-facturador`.

- Compatible con **Mint 21.x y Mint 22.x** (y Debian/Ubuntu recientes).
- Puede convivir con la otra aplicación «Pescadería Rana» (paquete distinto).
- Para desinstalar: `sudo apt remove pescaderia-rana-facturador`.

## Modo kiosco (pantalla completa al encender)

En el portátil de la tienda el facturador arranca **solo, en pantalla
completa y sin barra de menús**, cada vez que se enciende el PC. Lo gestiona
un servicio de usuario de systemd instalado en
`~/.config/systemd/user/facturador-kiosko.service` (está en la carpeta
`escritorio/` del repositorio).

- **Salir del kiosco**: `Ctrl+Alt+K` (lo alterna) o cerrar con `Ctrl+Alt+Q`.
  Si se cierra a propósito, **se queda cerrado hasta el próximo encendido**
  del PC; solo se reabre solo si la aplicación se cuelga o falla al arrancar.
- Si un día se pierde el arranque automático, se reinstala con:

  ```bash
  mkdir -p ~/.config/systemd/user
  cp escritorio/facturador-kiosko.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now facturador-kiosko
  ```

## Dónde están tus datos

- Se guardan **solo en este equipo**, en el perfil de la aplicación
  (`~/.config/Pescadería Rana — Facturador`).
- Copia de seguridad: **Registro Facturas → Guardar Copia de Seguridad**
  (descarga un JSON con clientes y facturas).
- Sin catálogos prefijados: la agenda de clientes empieza vacía.

## Notas

- **OCR del nº de lote**: el botón 📷 junto al campo «N° Lote (trazabilidad)»
  toma una foto de la papeleta y rellena el número solo. Funciona **sin
  conexión** (Tesseract empaquetado, con preprocesado de imagen) y muestra el
  % de confianza. Si guardas una clave de Gemini en Configuración, se usa la
  IA antes que el OCR local (eso sí necesita internet).
  - **Leer con el MÓVIL**: botón 📱 junto al de la cámara. En la pantalla
    aparece un código QR: lo enfocas con la cámara del móvil, se abre una
    página del propio PC (por el WiFi de casa), haces la foto de la papeleta
    con la cámara del móvil y **la foto llega al ordenador y se lee sola**.
    Mismo WiFi, sin cables ni cuentas. La sesión del QR caduca a los 15 min;
    si pasa, pulsa el botón otra vez.
  - El OCR **aprende de tus correcciones**: si lo corriges a mano o eliges
    otra lectura, la próxima vez lo escribirá solo como tú lo dejes.
  - **IA de Gemini (recomendado)**: con una clave configurada, cada foto va
    PRIMERO a la IA de Google, que lee manuscritos y papeletas difíciles con
    mucha más precisión; el motor local queda como respaldo sin conexión.
    - En escritorio: basta dejar un fichero `gemini-key.txt` (la clave en la
      primera línea) junto a la app; se importa sola al arrancar.
    - En la web: pegarla una vez en Configuración → Clave API Agente IA.
    - La clave nunca viaja dentro del paquete ni se sube a ningún repositorio.
- **Local + nube**: los datos SIEMPRE se guardan en este equipo. Además, si
  pegas tu `firebaseConfig` en Configuración → «Conectar e Iniciar
  Sincronización», facturas y clientes se sincronizan en los dos sentidos
  (gana el cambio más reciente) y sin conexión la subida se guarda en cola y
  se envía al volver la red. Para desactivarla: «Desconectar Nube».
- La sincronización usa Firestore; en tu proyecto Firebase debe existir (o
  dejarse crear) las colecciones `clients` e `invoices`, con reglas de
  seguridad acordes.
