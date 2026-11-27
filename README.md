# Draw on Screenshot (GNOME Shell Extension)

Dibuja y anota directamente sobre la interfaz nativa interactiva de captura de pantalla de GNOME (`Main.screenshotUI`) al estilo **Lightshot**, con herramientas vectoriales, atajos configurables, paleta de colores editable, control de grosor, censura por pixelado y atenuación dinámica de menús.

Compatible con **GNOME Shell 48, 49, 50 y 51**.

> El código usa APIs que no existen antes de GNOME 48 (`St.BoxLayout.orientation`,
> `global.stage.context`), así que declarar 45–47 era incorrecto: ahí no funciona.
> Verificado en 50 y 51; 48 y 49 se declaran por compatibilidad de API.

---

## ✨ Características

- ✏️ **Lápiz libre**: trazo fluido a mano alzada (`P`).
- 📏 **Línea recta**: punto a punto (`L`). `Mayús` imanta el ángulo a múltiplos de 45°.
- ↗️ **Flecha**: punta sólida que no sobrepasa el cuerpo (`A`). También admite `Mayús`.
- 🔲 **Rectángulo** (`R`) y ⭕ **elipse** (`O`): `Mayús` fuerza cuadrado o círculo,
  `Ctrl` dibuja desde el centro, y el botón de relleno (`F`) alterna contorno/relleno.
- 🖍️ **Resaltador**: marcador translúcido (`H`).
- 🔤 **Texto**: entrada en pantalla, `Enter` confirma y `Esc` cancela (`T`).
  Se dibuja con Pango, el mismo motor que el resto del escritorio, así que sale con
  **grosor normal**; la negrita es opcional desde preferencias. Con la herramienta de
  texto activa, **arrastrá una anotación ya escrita para reubicarla**.
- 🔢 **Contador automático**: burbujas numeradas al estilo Flameshot (`N`). Cada clic
  coloca el siguiente número, y deshacer/rehacer reajustan la serie sola.
- 🌫️ **Pixelado**: arrastrá sobre una región para censurarla (`X`). No es un mosaico
  pintado encima: **transforma la imagen de debajo**, en vivo y en la GPU, como el
  censurado de iOS o WhatsApp. Lo que ves es lo que se guarda. El bloque es de 4 px
  lógicos de fábrica y se puede bajar hasta 2 o subir hasta 64 desde preferencias.
- 🎨 **Paleta editable**: botón compacto con la paleta configurada (`C` para rotar).
  Se abre como overlay sobre el stage, sin ensanchar la barra.
- 📏 **Grosor de trazo**: botones `[-]` / `[+]`, rueda del ratón, y `Ctrl` + rueda
  en cualquier punto de la pantalla.
- 🎯 **Preview del pincel**: círculo bajo el cursor con el grosor y color reales; con
  el contador activo muestra el número que se va a colocar.
- 💬 **Rótulos de ayuda**: cada botón explica al pasar el puntero qué hace y con qué
  atajo, incluidos los modificadores `Mayús` y `Ctrl`.
- 🌑 **Sombra opcional** bajo las anotaciones, para que se lean sobre cualquier fondo.
- ↩️ **Deshacer y rehacer**: `Ctrl+Z` y `Ctrl+Mayús+Z`.
- 🗑️ **Limpiar lienzo** (`Supr`), reversible con deshacer.
- ⚙️ **Preferencias**: qué botones aparecen y en qué orden, la paleta, los atajos y
  los valores por defecto. Ver [Preferencias](#️-preferencias).
- 🌫️ **Atenuación dinámica**: los menús se vuelven translúcidos mientras dibujás.
- 🚀 **Nativo y HiDPI**: compositing 2D con Cairo antes de guardar en disco o copiar al portapapeles.

La barra de dibujo **está siempre visible** mientras la UI de captura está abierta,
centrada justo encima del panel nativo de modos.

**Ninguna herramienta viene activada de fábrica.** Mientras no elijas una, el
lienzo es inerte y la captura se comporta exactamente como la nativa: si sólo
querés capturar, no hay nada que esquivar. Al pulsar una herramienta el lienzo se
activa; al volver a pulsarla se desactiva.

### Cómo convive el dibujo con la selección de área

El lienzo cubre **toda la pantalla**: se puede dibujar donde sea, también fuera del
área seleccionada.

Para que eso no deje inservible al selector de área nativo, el lienzo sólo es
reactivo cuando hay una herramienta activa. Sin herramienta seleccionada el
lienzo es completamente inerte y los clics llegan al selector como siempre.

Esto importa a nivel técnico: en Clutter el evento se entrega al actor reactivo
más alto, y devolver `EVENT_PROPAGATE` lo pasa al **padre**, nunca a un hermano
que esté debajo. Un lienzo reactivo a pantalla completa no puede devolverle el
evento al selector; sólo dejando de ser reactivo se consigue.

---

## ⌨️ Atajos de Teclado

Todos son **configurables** desde las preferencias; esta tabla son los valores de fábrica.

| Atajo | Acción |
| :--- | :--- |
| **`P`** | Lápiz libre |
| **`L`** | Línea recta |
| **`A`** | Flecha |
| **`R`** | Rectángulo |
| **`O`** | Elipse |
| **`H`** | Resaltador |
| **`T`** | Texto |
| **`N`** | Contador automático |
| **`X`** | Pixelar |
| **`F`** | Alternar relleno de figuras |
| **`C`** | Color siguiente |
| **`+`** / **`-`** | Aumentar / disminuir grosor |
| **`Ctrl`** + **rueda** | Aumentar / disminuir grosor |
| **`Ctrl`** + **`Z`** | Deshacer |
| **`Ctrl`** + **`Mayús`** + **`Z`** | Rehacer |
| **`Supr`** | Limpiar todo |
| **`Esc`** | Suelta la herramienta activa; sin herramienta, cierra la captura |

Modificadores durante el arrastre, no configurables:

| Modificador | Efecto |
| :--- | :--- |
| **`Mayús`** | Línea y flecha imantadas a 45°; cuadrado en vez de rectángulo; círculo en vez de elipse |
| **`Ctrl`** | Rectángulo, elipse y pixelado se dibujan desde el centro |

Los atajos de una sola letra se desactivan mientras escribís una anotación de texto.

`Esc` se desanda por capas: primero cierra la paleta desplegable, después suelta la
herramienta activa, y sólo cuando no queda nada seleccionado cierra la interfaz de
captura. Así no se pierde la captura por querer cambiar de herramienta.

Los atajos se comparan primero por el símbolo de la tecla y, con distribuciones **no
latinas** (cirílico, griego, hebreo, árabe, kana…), por la **posición física** de la
tecla. Con una distribución latina manda siempre el símbolo, de modo que AZERTY o
Dvorak siguen respondiendo a la tecla que está rotulada.

Tienen **prioridad sobre los atajos nativos** de la interfaz de captura: en GNOME 50
`P` alterna el puntero, y con la extensión activa selecciona el lápiz. El botón del
panel nativo sigue funcionando, y cualquier atajo se puede reasignar o desactivar
desde las preferencias.

---

## ⚙️ Preferencias

```bash
gnome-extensions prefs draw-on-screenshot@ricardojparram
```

Tres páginas:

- **Barra de herramientas** — qué herramientas aparecen y **en qué orden**, más el
  selector de color, el interruptor de relleno, el control de grosor, deshacer/rehacer,
  limpiar y los rótulos de ayuda. Un control oculto sigue funcionando por atajo.
- **Dibujo** — paleta editable (añadir, quitar, reordenar, restaurar), grosor por
  defecto, relleno por defecto, sombra, negrita y familia tipográfica del texto,
  primer número del contador y tamaño de bloque del pixelado.
- **Atajos** — una fila por acción; al pulsarla se captura la combinación.
  `Retroceso` desactiva el atajo y `Escape` conserva el actual.

Los cambios se aplican **en caliente**: la barra se reconstruye sin reiniciar el Shell.

---

## 📦 Instalación

```bash
git clone https://github.com/ricardojparram/draw-on-screenshot-gnome-extension.git \
  ~/.local/share/gnome-shell/extensions/draw-on-screenshot@ricardojparram
cd ~/.local/share/gnome-shell/extensions/draw-on-screenshot@ricardojparram
glib-compile-schemas schemas/          # sin esto no hay preferencias
gnome-extensions enable draw-on-screenshot@ricardojparram
```

`gschemas.compiled` es un artefacto de compilación y no se versiona; el zip
publicado en extensions.gnome.org sí lo trae ya compilado.

Recargá la sesión de GNOME:

- **X11**: `Alt` + `F2`, escribí `r`, `Enter`.
- **Wayland**: cerrá sesión y volvé a entrar — o usá el shell anidado que se
  describe abajo, que no requiere logout.

---

## 🛠️ Desarrollo en Wayland sin cerrar sesión

En Wayland no existe `Alt+F2` → `r`. En GNOME 50 el modo anidado es el **devkit**,
que vive en un paquete aparte:

```bash
sudo dnf install mutter-devkit        # Fedora
```

Sin ese binario, `gnome-shell --devkit` avisa `Failed to launch devkit` y no abre
ventana; y `gnome-shell --wayland` a secas intenta tomar la sesión real y aborta
con `EBUSY`. No hay otra vía de anidado.

Enlazá el repo a la carpeta de extensiones para que el shell lea tus ediciones:

```bash
ln -sfn "$PWD" ~/.local/share/gnome-shell/extensions/draw-on-screenshot@ricardojparram
```

Para una sesión de pruebas aislada, que no toque el dconf ni las extensiones de tu
escritorio diario:

```bash
DEV=~/.local/share/gs-dev
mkdir -p "$DEV/data/gnome-shell/extensions" "$DEV/config"
ln -sfn "$PWD" "$DEV/data/gnome-shell/extensions/draw-on-screenshot@ricardojparram"

XDG_DATA_HOME="$DEV/data" XDG_CONFIG_HOME="$DEV/config" \
  dbus-run-session -- sh -c '
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"draw-on-screenshot@ricardojparram\"]"
    exec gnome-shell --devkit --wayland
  '
```

Ciclo: editar → cerrar la ventana anidada → relanzar. Logs en otra terminal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

---

## 🏗️ Arquitectura del Código

```
├── metadata.json                 # Metadatos y versiones soportadas
├── stylesheet.css                # Estilos Adwaita Dark
├── extension.js                  # Entrypoint del ciclo de vida
├── prefs.js                      # Ventana de preferencias (Adw/Gtk)
├── schemas/                      # Esquema GSettings propio
├── locale/                       # Traducciones compiladas (.mo)
├── po/                           # Plantilla y catálogos de traducción
├── icons/                        # Iconos simbólicos propios (flecha, elipse, contador…)
└── src/
    ├── core/
    │   ├── drawingModel.js       # Estado, herramientas, colores, undo/redo
    │   ├── settings.js           # Colores hex y análisis de aceleradores
    │   └── compositor.js         # Compositor Cairo + pixelado sobre GdkPixbuf
    ├── ui/
    │   ├── drawingCanvas.js      # St.DrawingArea interactivo + renderStroke()
    │   ├── drawingToolbar.js     # Barra de herramientas
    │   ├── pixelateOverlay.js    # Pixelado en vivo por shader (Shell.GLSLEffect)
    │   └── tooltip.js            # Rótulos emergentes (St no trae tooltips)
    └── patcher.js                # Interceptor de Main.screenshotUI
```

### Sistemas de coordenadas

Los trazos se guardan **siempre en coordenadas lógicas del stage**. Al estampar:

```
destino = punto * scale - offset
```

donde `offset` ya viene en **píxeles de buffer** (así lo devuelve
`ScreenshotUI._getSelectedGeometry(true)`, que multiplica por `_scale`). Para
capturas de ventana el origen es el *buffer rect* de la ventana por su
`bufferScale`, no el origen del stage.

### Pixelado

El mosaico no se pinta encima: hay que **reemplazar** lo que hay debajo. Y desde JS
no se pueden leer los píxeles del stage, así que se resuelve en dos sitios distintos.

**En pantalla** manda la GPU. La interfaz de captura congela la pantalla en un
`Clutter.Content`, que se puede compartir con otros actores; cada región cuelga uno
recortado a su rectángulo y le aplica un `Shell.GLSLEffect` cuyo fragment shader
vuelve a muestrear la textura en el centro del bloque de cada píxel. Dos trampas que
vale la pena recordar:

- `Clutter.ShaderEffect` ya no se puede construir desde JS: mutter dejó de exponer
  `ClutterShaderType`. El reemplazo es `Shell.GLSLEffect`.
- El enganche `TEXTURE_LOOKUP` parece el natural, pero `add_glsl_snippet` pasa el
  código como fragmento *posterior* al muestreo, así que redondear `cogl_tex_coord`
  ahí no hace nada. Hay que usar el enganche `FRAGMENT` y muestrear a mano.
- Un `St.Widget` sin layout manager **no asigna a sus hijos**: quedan con asignación
  infinita y no se pintan. Las regiones usan `Clutter.FixedLayout`.

**Al guardar** manda GdkPixbuf, en C: cada región se reduce con
`scale_simple(BILINEAR)` —que promedia cada bloque— y se vuelve a ampliar con
`NEAREST` —que los repite—. La retícula se alinea con la región en ambos casos, de
modo que la vista previa y el PNG coinciden.

### Publicación en extensions.gnome.org

Empaquetado (los `--extra-source` son obligatorios: sin ellos `pack` deja fuera
los subdirectorios y la extensión no carga):

```bash
gnome-extensions pack \
  --extra-source=src --extra-source=icons --extra-source=LICENSE \
  --schema=schemas/org.gnome.shell.extensions.draw-on-screenshot.gschema.xml \
  --podir=po --gettext-domain=draw-on-screenshot .
```

Comprobación previa con el analizador estático que recomienda el propio sitio:

```bash
pip install -U shexli
shexli draw-on-screenshot@ricardojparram.shell-extension.zip
```

Quedan dos hallazgos conocidos, ambos revisados:

- `EGO-A-005` *(manual_review)* — acceso al portapapeles. Es inherente: la UI
  nativa de captura copia la imagen y sin eso se rompería esa expectativa. La
  guía exige declararlo en la descripción, y `metadata.json` lo declara.
- `EGO-P-003` — desde que la extensión define esquema propio, la regla sí aplica:
  el id es `org.gnome.shell.extensions.draw-on-screenshot`, la ruta
  `/org/gnome/shell/extensions/draw-on-screenshot/` y `metadata.json` lo declara en
  `settings-schema`. Aparte de ese esquema sólo se lee
  `org.gnome.desktop.lockdown` del sistema, para respetar el bloqueo de escritura
  en disco.

El campo `version` de `metadata.json` no se toca: lo asigna el sitio en cada
subida, y de ahí salen las actualizaciones automáticas.

### Teclado: fase y actor

Los atajos se conectan en fase de **captura** y **sobre `Main.screenshotUI`**, no
sobre el stage. Las dos cosas importan:

- `key-press-event` en el stage es fase de burbuja, y el evento sólo llega si nadie
  lo consumió antes. La interfaz nativa de captura se queda con las teclas.
- Pasar a `captured-event` en el stage tampoco basta: `Main.pushModal` instala un
  `Clutter.Grab` sobre `screenshotUI`, y con un grab activo la cadena de propagación
  arranca en el actor del grab. El stage deja de ver el evento.

De ahí que se conecte dentro del grab: `captured-event` para lo que va a los
descendientes y `key-press-event` para cuando el destino es `screenshotUI` misma
(ahí no se emite fase de captura, y `connect()` corre antes que el `vfunc` de la
clase, que es RUN_LAST). El stage queda como red de seguridad para el caso sin grab.

### Nota de fragilidad

`_saveScreenshot` se sobrescribe replicando lógica interna del Shell. Si una
versión futura cambia esos campos, la extensión lo detecta al habilitarse
(`REQUIRED_UI_FIELDS`) y deja el guardado nativo intacto en lugar de romperlo.
Si el compositing falla en tiempo de ejecución, se guarda la captura **sin**
anotaciones antes que perderla.

---

## 📄 Licencia

GPL-3.0-or-later. Texto completo en [LICENSE](LICENSE).
