import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { DrawingModel, ToolType, ToolOrder } from './core/drawingModel.js';
import { DrawingCanvas } from './ui/drawingCanvas.js';
import { DrawingToolbar } from './ui/drawingToolbar.js';
import { PixelateLayer } from './ui/pixelateOverlay.js';
import { TooltipManager } from './ui/tooltip.js';
import { ScreenshotCompositor } from './core/compositor.js';
import { parseAccelerator, acceleratorMatches } from './core/settings.js';
import { logError, logWarning, logDebug } from './core/log.js';

/**
 * Separación vertical, en px lógicos, entre el borde superior del panel nativo y
 * la barra de dibujo. El botón de cerrar mide 32 px y sobresale unos 24 px por
 * encima del panel, así que este hueco lo libra dejando algo de aire.
 */
const TOOLBAR_PANEL_GAP = 34;

/**
 * Clave de GSettings de cada atajo y qué hace al dispararse. El valor es una
 * función del modelo para que añadir una acción no obligue a tocar el
 * despachador de teclas.
 */
const SHORTCUT_ACTIONS = {
    'key-tool-pen': model => model.setActiveTool(ToolType.PEN),
    'key-tool-line': model => model.setActiveTool(ToolType.LINE),
    'key-tool-arrow': model => model.setActiveTool(ToolType.ARROW),
    'key-tool-rect': model => model.setActiveTool(ToolType.RECT),
    'key-tool-ellipse': model => model.setActiveTool(ToolType.ELLIPSE),
    'key-tool-highlighter': model => model.setActiveTool(ToolType.HIGHLIGHTER),
    'key-tool-text': model => model.setActiveTool(ToolType.TEXT),
    'key-tool-counter': model => model.setActiveTool(ToolType.COUNTER),
    'key-tool-pixelate': model => model.setActiveTool(ToolType.PIXELATE),
    'key-undo': model => model.undo(),
    'key-redo': model => model.redo(),
    'key-clear': model => model.clear(),
    'key-cycle-color': model => model.cycleColor(),
    'key-increase-size': model => model.increaseSize(),
    'key-decrease-size': model => model.decreaseSize(),
    'key-toggle-fill': model => model.toggleFill(),
};

/** Claves de GSettings que sólo afectan a cómo se construye la barra. */
const TOOLBAR_KEYS = [
    'enabled-tools', 'show-color-picker', 'show-size-stepper', 'show-fill-toggle',
    'show-undo-redo', 'show-clear', 'show-tooltips', 'palette',
];

/** Campos de ScreenshotUI de los que depende el guardado con anotaciones. */
const REQUIRED_UI_FIELDS = [
    '_saveScreenshot',
    '_getSelectedGeometry',
    '_stageScreenshot',
    '_selectionButton',
    '_screenButton',
    '_windowButton',
    '_areaSelector',
];

export class ScreenshotPatcher {
    /**
     * @param {string|null} iconsPath Ruta al directorio `icons/` de la extensión.
     * @param {Gio.Settings|null} settings Preferencias propias de la extensión.
     */
    constructor(iconsPath = null, settings = null) {
        this._model = new DrawingModel();
        this._iconsPath = iconsPath;
        this._settings = settings;
        this._settingsChangedId = null;
        this._bindings = new Map();
        this._prefs = {};
        this._tooltips = null;
        this._pixelateLayer = null;
        this._modelListener = null;
        this._toolbar = null;
        this._drawingCanvas = null;
        this._signals = [];
        this._eventHandlers = [];
        this._uiHandlers = [];
        this._retryId = null;
        this._canPatchSave = false;

        this._origOpen = null;
        this._origClose = null;
        this._origSaveScreenshot = null;

        // Esquema de SISTEMA, provisto por gnome-desktop. La extensión no define
        // ni empaqueta ningún esquema propio: sólo lee `disable-save-to-disk`
        // para respetar el bloqueo administrativo de escritura en disco, igual
        // que hace el código nativo de captura del Shell.
        this._lockdownSettings = null;
        try {
            this._lockdownSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.lockdown',
            });
        } catch (e) {
            logWarning('No se pudo leer org.gnome.desktop.lockdown; ' +
                       'se asumirá que guardar en disco está permitido.');
        }
    }

    enable() {
        const ui = Main.screenshotUI;

        // Al iniciar sesión la extensión puede habilitarse antes de que el Shell
        // haya construido screenshotUI. Reintentar en vez de quedarse inerte.
        if (!ui) {
            if (this._retryId) return;
            this._retryId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._retryId = null;
                if (Main.screenshotUI) {
                    this.enable();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }

        this._canPatchSave = REQUIRED_UI_FIELDS.every(field => ui[field] !== undefined);
        if (!this._canPatchSave) {
            const missing = REQUIRED_UI_FIELDS.filter(field => ui[field] === undefined);
            logWarning('ScreenshotUI no expone ' + missing.join(', ') +
                '. Se dibujará en pantalla pero las anotaciones no se guardarán ' +
                'en la captura; el guardado nativo queda intacto.');
        }

        this._loadPrefs();

        if (this._settings && !this._settingsChangedId) {
            this._settingsChangedId = this._settings.connect('changed',
                (settings, key) => this._onSettingChanged(key));
        }

        this._cleanLeftovers(ui);
        this._createUIComponents(ui);
        this._hookMethods(ui);
        this._connectUIHandlers();
    }

    /**
     * Lee GSettings una sola vez y deja el resultado listo para el modelo, la
     * barra y el despachador de atajos. Sin esquema (por ejemplo si la
     * extensión se ejecuta desde el árbol de fuentes sin compilarlo) se usan
     * los valores por defecto del propio modelo.
     */
    _loadPrefs() {
        const settings = this._settings;

        const shortcuts = {};
        this._bindings = new Map();

        if (!settings) {
            this._prefs = { enabledTools: [...ToolOrder], shortcuts };
            return;
        }

        for (const key of Object.keys(SHORTCUT_ACTIONS)) {
            const accel = settings.get_string(key);
            shortcuts[key] = accel;
            const binding = parseAccelerator(accel);
            if (binding) {
                this._bindings.set(key, binding);
            }
        }

        this._prefs = {
            enabledTools: settings.get_strv('enabled-tools'),
            showColorPicker: settings.get_boolean('show-color-picker'),
            showSizeStepper: settings.get_boolean('show-size-stepper'),
            showFillToggle: settings.get_boolean('show-fill-toggle'),
            showUndoRedo: settings.get_boolean('show-undo-redo'),
            showClear: settings.get_boolean('show-clear'),
            showTooltips: settings.get_boolean('show-tooltips'),
            shortcuts,
        };

        this._model.applySettings({
            palette: settings.get_strv('palette'),
            defaultWidth: settings.get_int('default-width'),
            fillShapes: settings.get_boolean('fill-shapes'),
            strokeShadow: settings.get_boolean('stroke-shadow'),
            textBold: settings.get_boolean('text-bold'),
            fontFamily: settings.get_string('font-family'),
            counterStart: settings.get_int('counter-start'),
            pixelateBlock: settings.get_int('pixelate-block'),
        });
    }

    /**
     * Un cambio en preferencias se aplica en caliente. La barra sólo se
     * reconstruye si cambió algo que afecta a qué botones tiene o cómo se
     * rotulan; el resto lo absorbe el modelo sin tocar actores.
     */
    _onSettingChanged(key) {
        const rebuild = TOOLBAR_KEYS.includes(key) || key.startsWith('key-');
        this._loadPrefs();

        if (rebuild) {
            const ui = Main.screenshotUI;
            if (ui) this._rebuildToolbar(ui);
        }
    }

    disable() {
        const ui = Main.screenshotUI;

        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = null;
        }

        // 1. Desconectar listeners de teclado y rueda
        this._disconnectStageHandlers();
        this._disconnectUIHandlers();

        // 2. Restaurar métodos originales
        if (ui && this._origSaveScreenshot) {
            ui._saveScreenshot = this._origSaveScreenshot;
            this._origSaveScreenshot = null;
        }

        if (ui && this._origOpen) {
            ui.open = this._origOpen;
            this._origOpen = null;
        }

        if (ui && this._origClose) {
            ui.close = this._origClose;
            this._origClose = null;
        }

        // 3. Desconectar señales
        for (const [obj, id] of this._signals) {
            try {
                if (obj && id) obj.disconnect(id);
            } catch (e) {
                // ignorar
            }
        }
        this._signals = [];

        // 4. Dejar de escuchar cambios en preferencias
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        // 5. Devolver la opacidad de los menús, que pudo quedar atenuada
        this._restoreMenuOpacity();

        // 6. Destruir componentes visuales
        if (this._tooltips) {
            this._tooltips.destroy();
            this._tooltips = null;
        }

        if (this._toolbar) {
            this._toolbar.destroy();
            this._toolbar = null;
        }

        if (this._drawingCanvas) {
            this._drawingCanvas.destroy();
            this._drawingCanvas = null;
        }

        if (this._modelListener) {
            this._model.removeListener(this._modelListener);
            this._modelListener = null;
        }

        if (this._pixelateLayer) {
            this._pixelateLayer.destroy();
            this._pixelateLayer = null;
        }

        if (ui) {
            this._cleanLeftovers(ui);
        }
    }

    /**
     * Manejadores de teclado y rueda mientras la interfaz de captura está abierta.
     *
     * La fase y el actor importan, y ambos costaron un intento fallido:
     *
     *   1. `key-press-event` en el stage es fase de BURBUJA: el evento sólo llega
     *      ahí si nadie lo consumió antes, y la interfaz nativa de captura se
     *      queda con las teclas (`p` alterna el puntero, por ejemplo).
     *   2. Pasar a `captured-event` en el stage tampoco basta: `Main.pushModal`
     *      instala un `Clutter.Grab` sobre `screenshotUI`, y con un grab activo
     *      la cadena de propagación arranca en el actor del grab, no en el stage.
     *      El stage deja de ver el evento por completo.
     *
     * Por eso se conecta DENTRO del grab, sobre `screenshotUI`:
     *   - `captured-event` atrapa lo que va dirigido a sus descendientes (los
     *     botones del panel), antes de que ellos lo consuman;
     *   - `key-press-event` cubre el caso en que el destino sea `screenshotUI`
     *     misma, donde la fase de captura no se emite. Al conectar con `connect()`
     *     el manejador corre ANTES que el `vfunc_key_press_event` de la clase,
     *     que es RUN_LAST.
     *
     * En GNOME 51 las teclas nativas pasan a un `Clutter.BindingPool` que se
     * despacha antes que `key-press-event`, así que esa señal ya no ve las
     * teclas que la interfaz consume. No hace falta: ahí `captured-event` sí
     * se emite sobre el actor con el foco y los atajos conservan la prioridad.
     *
     * El stage se mantiene como red de seguridad para el caso sin grab. No hay
     * riesgo de actuar dos veces: el primero que encaja devuelve `EVENT_STOP` y
     * corta la propagación.
     *
     * Estos dos van puestos desde que se habilita la extensión y no se sueltan
     * al cerrar la captura: `screenshotUI` sólo recibe eventos mientras está
     * abierta, así que no cuesta nada dejarlos, y así los atajos responden
     * aunque la interfaz se abra por un camino que no pase por el `open()`
     * parcheado (por ejemplo si otra extensión lo sustituye después).
     */
    _connectUIHandlers() {
        const ui = Main.screenshotUI;
        if (!ui || this._uiHandlers.length > 0) return;

        const onCaptured = (actor, event) => this._onCapturedEvent(event);
        this._uiHandlers.push([ui, ui.connect('captured-event', onCaptured)]);
        this._uiHandlers.push([ui, ui.connect('key-press-event', onCaptured)]);
    }

    /**
     * Red de seguridad sobre el stage para el caso sin grab. Ésta sí va y viene
     * con la interfaz: en fase de captura el stage ve TODOS los eventos, también
     * los de movimiento, y no conviene pagar eso con la interfaz cerrada.
     */
    _connectStageHandlers() {
        this._connectUIHandlers();

        if (this._eventHandlers.length > 0) return;

        const onCaptured = (actor, event) => this._onCapturedEvent(event);
        this._eventHandlers.push(
            [global.stage, global.stage.connect('captured-event', onCaptured)]);
    }

    _disconnectStageHandlers() {
        for (const [obj, id] of this._eventHandlers) {
            try {
                obj.disconnect(id);
            } catch (e) {
                // ignorar
            }
        }
        this._eventHandlers = [];
    }

    _disconnectUIHandlers() {
        for (const [obj, id] of this._uiHandlers) {
            try {
                obj.disconnect(id);
            } catch (e) {
                // ignorar
            }
        }
        this._uiHandlers = [];
    }

    _onCapturedEvent(event) {
        if (!Main.screenshotUI?.visible) {
            return Clutter.EVENT_PROPAGATE;
        }

        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS) {
            return this._onStageKeyPress(event);
        }
        if (type === Clutter.EventType.SCROLL) {
            return this._onStageScroll(event);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Ctrl + rueda ajusta el grosor del trazo en cualquier punto de la pantalla. */
    _onStageScroll(event) {
        if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) === 0) {
            return Clutter.EVENT_PROPAGATE;
        }

        const direction = event.get_scroll_direction();
        if (direction !== Clutter.ScrollDirection.UP &&
            direction !== Clutter.ScrollDirection.DOWN) {
            return Clutter.EVENT_PROPAGATE;
        }

        if (direction === Clutter.ScrollDirection.UP) {
            this._model.increaseSize();
        } else {
            this._model.decreaseSize();
        }

        const [x, y] = event.get_coords();
        this._drawingCanvas?.setPointer(x, y);
        return Clutter.EVENT_STOP;
    }

    _cleanLeftovers(ui) {
        const containers = [ui, ui._panel, ui._primaryMonitorBin];
        try {
            for (const container of containers) {
                if (!container) continue;
                for (const child of container.get_children()) {
                    if (child.has_style_class_name &&
                        (child.has_style_class_name('screenshot-draw-toolbar') ||
                         child.has_style_class_name('screenshot-draw-color-popover') ||
                         child.has_style_class_name('screenshot-draw-tooltip') ||
                         child.has_style_class_name('screenshot-draw-pixelate-layer'))) {
                        container.remove_child(child);
                        child.destroy();
                    }
                }
            }
        } catch (e) {
            logError('Error limpiando residuos en ScreenshotUI', e);
        }
    }

    _setMenuOpacity(opacity) {
        const duration = 200;
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        const ui = Main.screenshotUI;

        if (ui && ui._panel) {
            ui._panel.ease({ opacity, duration, mode });
        }
        if (ui && ui._closeButton) {
            ui._closeButton.ease({ opacity, duration, mode });
        }
        if (this._toolbar && this._toolbar.visible) {
            this._toolbar.ease({ opacity, duration, mode });
        }
    }

    _restoreMenuOpacity() {
        const ui = Main.screenshotUI;
        try {
            if (ui && ui._panel) ui._panel.opacity = 255;
            if (ui && ui._closeButton) ui._closeButton.opacity = 255;
        } catch (e) {
            // ignorar
        }
    }

    _createUIComponents(ui) {
        // --- 0. Capa de pixelado ---
        // Va DEBAJO del lienzo: transforma la pantalla congelada, y las
        // anotaciones vectoriales tienen que poder dibujarse encima.
        this._pixelateLayer = new PixelateLayer(this._model);
        ui.add_child(this._pixelateLayer.build());

        this._modelListener = () => this._pixelateLayer?.sync();
        this._model.addListener(this._modelListener);

        // --- 1. Lienzo de dibujo ---
        // Se recorta al área seleccionada (ver _syncCanvasGeometry) en lugar de
        // cubrir todo el stage: así el selector de área sigue recibiendo eventos
        // fuera de la selección, ahora que el dibujo está siempre activo.
        this._drawingCanvas = new DrawingCanvas(this._model, {
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._drawingCanvas.visible = false;

        const drawStartId = this._drawingCanvas.connect('draw-started', () => {
            this._toolbar?.closePopover();
            this._setMenuOpacity(60);
        });
        const drawEndId = this._drawingCanvas.connect('draw-ended', () => {
            this._setMenuOpacity(255);
        });
        this._signals.push([this._drawingCanvas, drawStartId], [this._drawingCanvas, drawEndId]);

        ui.add_child(this._drawingCanvas);

        // --- 2. Barra de herramientas, siempre visible sobre el panel ---
        this._tooltips = new TooltipManager();
        this._tooltips.setContainer(ui);
        this._buildToolbar(ui, false);

        // --- 3. Mantener el lienzo alineado con la selección ---
        if (ui._areaSelector) {
            const dragStartId = ui._areaSelector.connect('drag-started', () => {
                this._toolbar?.closePopover();
                this._setMenuOpacity(100);
            });
            const dragEndId = ui._areaSelector.connect('drag-ended', () => {
                this._setMenuOpacity(255);
            });
            this._signals.push([ui._areaSelector, dragStartId], [ui._areaSelector, dragEndId]);
        }

        for (const button of [ui._selectionButton, ui._screenButton, ui._windowButton]) {
            if (!button) continue;
            const id = button.connect('notify::checked', () => this._syncCanvasGeometry());
            this._signals.push([button, id]);
        }
    }

    /**
     * Crea la barra y la ancla al panel nativo.
     *
     * @param {object} ui `Main.screenshotUI`
     * @param {boolean} visible Estado inicial: al reconstruirla en caliente hay
     *   que devolverla al estado en que estaba la anterior.
     */
    _buildToolbar(ui, visible) {
        this._tooltips?.setEnabled(this._prefs.showTooltips !== false);

        this._toolbar = new DrawingToolbar(
            this._model, this._iconsPath, this._prefs, this._tooltips);
        this._toolbar.visible = visible;

        // Anclada al panel nativo mediante constraints: siguen su asignación sola,
        // también durante la animación de apertura. Posicionarla a mano la dejaba
        // clavada donde estuviese el panel en el primer frame.
        if (ui._panel && ui._primaryMonitorBin) {
            this._toolbar.add_constraint(new Clutter.BindConstraint({
                source: ui._panel,
                coordinate: Clutter.BindCoordinate.POSITION,
            }));
            this._toolbar.add_constraint(new Clutter.AlignConstraint({
                source: ui._panel,
                align_axis: Clutter.AlignAxis.Y_AXIS,
                factor: 0.0,
                pivot_point: new Graphene.Point({ x: -1, y: 1.0 }),
            }));
            this._toolbar.add_constraint(new Clutter.AlignConstraint({
                source: ui._panel,
                align_axis: Clutter.AlignAxis.X_AXIS,
                factor: 0.5,
                pivot_point: new Graphene.Point({ x: 0.5, y: -1 }),
            }));

            // Separación suficiente para no pisar el botón de cerrar, que
            // sobresale por encima del borde superior del panel.
            this._toolbar.translation_y = -TOOLBAR_PANEL_GAP;

            ui._primaryMonitorBin.add_child(this._toolbar);
        }

        // La paleta flota por encima de todo y no forma parte de la barra, de
        // modo que abrirla no la ensancha.
        const popover = this._toolbar.colorPopover;
        if (popover) {
            ui.add_child(popover);
        }
        const popoverId = this._toolbar.connect('color-popover-toggled', () => {
            this._positionColorPopover();
        });
        this._signals.push([this._toolbar, popoverId]);
    }

    /**
     * Rehace la barra tras un cambio de preferencias. Los botones dependen de la
     * configuración en su composición, su orden y sus rótulos, así que sale más
     * barato y más fiable reconstruirla que ir parcheándola pieza a pieza.
     */
    _rebuildToolbar(ui) {
        const wasVisible = this._toolbar?.visible ?? false;

        this._signals = this._signals.filter(([obj, id]) => {
            if (obj !== this._toolbar) return true;
            try {
                obj.disconnect(id);
            } catch (e) {
                // ignorar
            }
            return false;
        });

        this._tooltips?.hide();

        if (this._toolbar) {
            this._toolbar.get_parent()?.remove_child(this._toolbar);
            this._toolbar.destroy();
            this._toolbar = null;
        }

        this._buildToolbar(ui, wasVisible);
        this._raiseActors(ui);
    }

    /**
     * El lienzo cubre todo el stage: se puede dibujar en cualquier parte, también
     * fuera de la selección. Mientras no haya herramienta activa el lienzo no es
     * reactivo, así que el selector de área sigue recibiendo los clics.
     */
    _syncCanvasGeometry() {
        const ui = Main.screenshotUI;
        if (!ui || !this._drawingCanvas) return;

        this._drawingCanvas.set_position(0, 0);
        this._drawingCanvas.set_size(global.stage.width, global.stage.height);
        this._drawingCanvas.visible = true;
        this._raiseActors(ui);
    }

    /** Monitor que contiene el punto dado, con la pantalla primaria como respaldo. */
    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors ?? [];
        return monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
            ?? Main.layoutManager.primaryMonitor
            ?? monitors[0]
            ?? { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
    }

    /** Sitúa la paleta flotante bajo el botón de color, o encima si no cabe. */
    _positionColorPopover() {
        const ui = Main.screenshotUI;
        const popover = this._toolbar?.colorPopover;
        const button = this._toolbar?.colorButton;
        if (!ui || !popover || !button || !popover.visible) return;

        const [buttonX, buttonY] = button.get_transformed_position();
        if (!Number.isFinite(buttonX) || !Number.isFinite(buttonY)) return;

        const [, popoverWidth] = popover.get_preferred_width(-1);
        const [, popoverHeight] = popover.get_preferred_height(-1);
        const GAP = 8;
        const monitor = this._monitorAt(buttonX, buttonY);

        let x = buttonX + button.width / 2 - popoverWidth / 2;
        x = Math.max(monitor.x + GAP,
            Math.min(x, monitor.x + monitor.width - popoverWidth - GAP));

        let y = buttonY + button.height + GAP;
        if (y + popoverHeight > monitor.y + monitor.height - GAP) {
            y = buttonY - popoverHeight - GAP;
        }

        popover.set_position(Math.round(x), Math.round(y));
        if (popover.get_parent() === ui) {
            ui.set_child_above_sibling(popover, null);
        }
    }


    /**
     * Orden de apilado, de abajo arriba: selector de área, lienzo, panel nativo,
     * barra de dibujo y paleta. La barra va sobre el panel para que nunca quede
     * tapada cuando la selección la empuja hacia el centro de la pantalla.
     */
    _raiseActors(ui) {
        try {
            // La capa de pixelado va justo encima de la pantalla congelada y
            // DEBAJO del selector de área: así el atenuado del selector cae
            // también sobre la zona censurada y no queda un recuadro más
            // brillante que el resto.
            const layer = this._pixelateLayer?.actor;
            if (layer?.get_parent() === ui) {
                if (ui._stageScreenshot?.get_parent() === ui) {
                    ui.set_child_above_sibling(layer, ui._stageScreenshot);
                } else {
                    ui.set_child_below_sibling(layer, null);
                }
            }
            if (this._drawingCanvas?.get_parent() === ui) {
                ui.set_child_above_sibling(this._drawingCanvas, null);
            }
            if (ui._primaryMonitorBin) {
                ui.set_child_above_sibling(ui._primaryMonitorBin, null);
            }
            const popover = this._toolbar?.colorPopover;
            if (popover?.get_parent() === ui) {
                ui.set_child_above_sibling(popover, null);
            }
        } catch (e) {
            logError('Error reordenando los actores de dibujo', e);
        }
    }

    /**
     * Corre en fase de captura, así que sólo puede consumir el evento cuando
     * hay una coincidencia exacta: cualquier otra tecla ha de seguir su camino
     * hasta la interfaz nativa (Escape, Intro, flechas del selector de área).
     */
    _onStageKeyPress(event) {
        // No secuestrar teclas mientras se escribe una anotación de texto: los
        // atajos son de una sola letra y se comerían lo que el usuario teclea.
        if (this._drawingCanvas?.hasTextEntry) {
            return Clutter.EVENT_PROPAGATE;
        }
        // Sólo un campo EDITABLE justifica ceder las teclas. Un `Clutter.Text` de
        // sólo lectura (el interior de cualquier St.Label) también puede acabar
        // con el foco, y comprobar únicamente el tipo dejaba los atajos mudos.
        const focus = global.stage.get_key_focus();
        if (focus instanceof Clutter.Text && focus.editable) {
            return Clutter.EVENT_PROPAGATE;
        }

        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const keycode = event.get_key_code?.() ?? 0;

        // Escape se desanda por capas: primero la paleta desplegable, luego la
        // herramienta activa y, sólo cuando no queda nada que soltar, el evento
        // sigue hasta la interfaz nativa, que es la que cierra la captura.
        if (symbol === Clutter.KEY_Escape) {
            if (this._toolbar?.isPopoverOpen) {
                this._toolbar.closePopover();
                return Clutter.EVENT_STOP;
            }
            if (this._model.hasActiveTool()) {
                this._tooltips?.hide();
                this._model.setActiveTool(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        for (const [key, binding] of this._bindings) {
            if (!acceleratorMatches(binding, symbol, state, keycode)) continue;

            const action = SHORTCUT_ACTIONS[key];
            if (!action) continue;

            this._tooltips?.hide();
            action(this._model);
            return Clutter.EVENT_STOP;
        }

        logDebug(`tecla sin atajo: symbol=${symbol} keycode=${keycode} state=${state}`);
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Origen de la captura de ventana, en píxeles de buffer.
     *
     * La textura de la ventana tiene su origen en el buffer rect (que incluye
     * los bordes invisibles del decorado), no en el origen del stage. Sin este
     * desplazamiento las anotaciones aparecían corridas por la posición de la
     * ventana en pantalla.
     */
    _getWindowOrigin(window) {
        const scale = window.bufferScale ?? 1;
        const rect = window.child?._bufferRect ??
                     window.child?.bufferRect ??
                     window.boundingBox;

        if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
            logWarning('No se pudo determinar el origen de la ventana; ' +
                       'las anotaciones podrían quedar desplazadas.');
            return [0, 0];
        }

        return [rect.x * scale, rect.y * scale];
    }

    _hookMethods(ui) {
        const self = this;

        this._origOpen = ui.open;
        ui.open = async function (mode) {
            self._model.reset();
            self._toolbar?.closePopover();
            self._drawingCanvas?.cancelTextEntry();

            if (self._toolbar) {
                self._toolbar.visible = true;
                self._toolbar.opacity = 255;
            }

            self._connectStageHandlers();

            const result = await self._origOpen.call(this, mode);
            self._syncCanvasGeometry();

            // La imagen congelada sólo existe una vez abierta la interfaz, y se
            // renueva en cada captura.
            self._pixelateLayer?.refreshSource();
            self._drawingCanvas?.setPixelatePreviewMode(
                self._pixelateLayer?.available ? 'overlay' : 'mosaic');
            self._pixelateLayer?.sync();

            return result;
        };

        this._origClose = ui.close;
        ui.close = function () {
            self._disconnectStageHandlers();

            self._tooltips?.hide();
            self._pixelateLayer?.hide();
            self._toolbar?.closePopover();
            self._drawingCanvas?.cancelTextEntry();
            if (self._toolbar) self._toolbar.visible = false;
            if (self._drawingCanvas) self._drawingCanvas.visible = false;
            self._restoreMenuOpacity();

            return self._origClose.call(this);
        };

        if (!this._canPatchSave) return;

        this._origSaveScreenshot = ui._saveScreenshot;
        ui._saveScreenshot = async function () {
            if (!self._model.hasStrokes()) {
                return self._origSaveScreenshot.call(this);
            }

            let file = null;

            try {
                if (this._selectionButton.checked || this._screenButton.checked) {
                    const content = this._stageScreenshot.get_content();
                    if (!content) return;

                    const texture = content.get_texture();
                    const geometry = this._getSelectedGeometry(true);

                    let cursorTexture = this._cursor.content?.get_texture();
                    if (!this._cursor.visible) {
                        cursorTexture = null;
                    }

                    const [x, y, w, h] = geometry ?? [0, 0, -1, -1];
                    const stream = Gio.MemoryOutputStream.new_resizable();

                    const rawPixbuf = await Shell.Screenshot.composite_to_stream(
                        texture,
                        x, y, w, h,
                        this._scale,
                        cursorTexture ?? null,
                        this._cursor.x * this._scale,
                        this._cursor.y * this._scale,
                        this._cursorScale,
                        stream
                    );
                    stream.close(null);

                    // geometry ya viene en píxeles de buffer (rescale = true).
                    const { bytes, pixbuf } = ScreenshotCompositor.composite(
                        rawPixbuf,
                        self._model,
                        geometry,
                        this._scale
                    );

                    global.display.get_sound_player().play_from_theme(
                        'screen-capture', _('Screenshot taken'), null);

                    file = self._storeScreenshot(bytes, pixbuf);
                } else if (this._windowButton.checked) {
                    const window = this._windowSelectors
                        .flatMap(selector => selector.windows())
                        .find(win => win.checked);

                    if (!window) return;

                    const content = window.windowContent;
                    if (!content) return;

                    const texture = content.get_texture();
                    let cursorTexture = window.getCursorTexture()?.get_texture();
                    if (!this._cursor.visible) {
                        cursorTexture = null;
                    }

                    const stream = Gio.MemoryOutputStream.new_resizable();

                    const rawPixbuf = await Shell.Screenshot.composite_to_stream(
                        texture,
                        0, 0, -1, -1,
                        window.bufferScale,
                        cursorTexture ?? null,
                        window.cursorPoint.x * window.bufferScale,
                        window.cursorPoint.y * window.bufferScale,
                        this._cursorScale,
                        stream
                    );
                    stream.close(null);

                    const { bytes, pixbuf } = ScreenshotCompositor.composite(
                        rawPixbuf,
                        self._model,
                        self._getWindowOrigin(window),
                        window.bufferScale
                    );

                    global.display.get_sound_player().play_from_theme(
                        'screen-capture', _('Screenshot taken'), null);

                    file = self._storeScreenshot(bytes, pixbuf);
                }
            } catch (e) {
                // Nunca perder la captura por un fallo al estampar las
                // anotaciones: se descarta el dibujo y se guarda la nativa.
                logError('Fallo al componer las anotaciones; se guarda la captura sin ellas', e);
                return self._origSaveScreenshot.call(this);
            }

            if (file) {
                this.emit('screenshot-taken', file);
            }
        };
    }

    _storeScreenshot(bytes, pixbuf) {
        // Acceso al portapapeles: se ESCRIBE la captura recién tomada, nunca se
        // lee. Reproduce el comportamiento del guardado nativo del Shell, que
        // deja la imagen lista para pegar; sin esto la extensión rompería una
        // expectativa básica de la UI de captura.
        const clipboard = St.Clipboard.get_default();
        clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

        const time = GLib.DateTime.new_now_local();
        let file = null;

        const disableSaveToDisk =
            this._lockdownSettings?.get_boolean('disable-save-to-disk') ?? false;

        if (!disableSaveToDisk) {
            const dir = Gio.File.new_for_path(GLib.build_filenamev([
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
                _('Screenshots'),
            ]));

            try {
                dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    logError('Error al crear directorio de capturas', e);
                }
            }

            const timestamp = time.format('%Y-%m-%d %H-%M-%S');
            const name = _('Screenshot From %s').format(timestamp);

            for (let i = 0; ; i++) {
                const suffix = i === 0 ? '' : `-${i}`;
                file = Gio.File.new_for_path(GLib.build_filenamev([
                    dir.get_path(), `${name}${suffix}.png`,
                ]));

                try {
                    const stream = file.create(Gio.FileCreateFlags.NONE, null);
                    stream.write_bytes(bytes, null);
                    stream.close(null);
                    break;
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                        logError('Error al escribir archivo de captura', e);
                        file = null;
                        break;
                    }
                }
            }
        }

        try {
            const coglContext = global.stage.context.get_backend().get_cogl_context();
            const pixels = pixbuf.read_pixel_bytes();
            const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
            content.set_bytes(
                coglContext,
                pixels,
                Cogl.PixelFormat.RGBA_8888,
                pixbuf.width,
                pixbuf.height,
                pixbuf.rowstride
            );

            const source = new MessageTray.Source({
                title: _('Screen Capture'),
                iconName: 'screenshooter-symbolic',
            });
            Main.messageTray.add(source);

            const notification = new MessageTray.Notification({
                source,
                title: _('Screenshot captured'),
                body: _('You can paste the image from the clipboard'),
                datetime: time,
                gicon: content,
                isTransient: true,
            });

            if (file) {
                const target = file;
                notification.addAction(_('Show in Files'), () => {
                    const app = Gio.app_info_get_default_for_type('inode/directory', false);
                    if (app) {
                        app.launch([target], global.create_app_launch_context(0, -1));
                    }
                });
                notification.connect('activated', () => {
                    try {
                        Gio.app_info_launch_default_for_uri(
                            target.get_uri(), global.create_app_launch_context(0, -1));
                    } catch (err) {
                        logError('Error al abrir la captura', err);
                    }
                });
            }

            source.addNotification(notification);
        } catch (e) {
            logError('Error al mostrar notificación de captura', e);
        }

        return file;
    }
}
