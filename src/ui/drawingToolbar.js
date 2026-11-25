import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ToolType, ToolOrder } from '../core/drawingModel.js';
import { describeAccelerator } from '../core/settings.js';

/**
 * Marcador para xgettext: deja las cadenas sin traducir aquí y las traduce
 * `_()` en el punto de uso, ya con el dominio de la extensión cargado.
 */
const N_ = str => str;

/**
 * Descripción de cada herramienta: icono propio, respaldo del tema, nombre y
 * la ayuda que explica qué hace y qué modificadores admite.
 *
 * Las cadenas se envuelven en `_()` en `_buildUI`, no aquí, para que xgettext
 * las vea en el punto de uso y la traducción se resuelva al construir la barra.
 */
const TOOL_INFO = {
    [ToolType.PEN]: {
        icon: 'dos-pen-symbolic',
        fallback: 'document-edit-symbolic',
        name: N_('Pen'),
        hint: N_('Draw freehand'),
        accel: 'key-tool-pen',
    },
    [ToolType.LINE]: {
        icon: 'dos-line-symbolic',
        fallback: 'draw-line-symbolic',
        name: N_('Line'),
        hint: N_('Straight line. Hold Shift to snap to 45°'),
        accel: 'key-tool-line',
    },
    [ToolType.ARROW]: {
        icon: 'dos-arrow-symbolic',
        fallback: 'go-next-symbolic',
        name: N_('Arrow'),
        hint: N_('Arrow pointing where you release. Hold Shift to snap to 45°'),
        accel: 'key-tool-arrow',
    },
    [ToolType.RECT]: {
        icon: 'dos-rect-symbolic',
        fallback: 'checkbox-symbolic',
        name: N_('Rectangle'),
        hint: N_('Hold Shift for a square, Ctrl to draw from the centre'),
        accel: 'key-tool-rect',
    },
    [ToolType.ELLIPSE]: {
        icon: 'dos-ellipse-symbolic',
        fallback: 'media-record-symbolic',
        name: N_('Ellipse'),
        hint: N_('Hold Shift for a circle, Ctrl to draw from the centre'),
        accel: 'key-tool-ellipse',
    },
    [ToolType.HIGHLIGHTER]: {
        icon: 'dos-highlighter-symbolic',
        fallback: 'edit-select-all-symbolic',
        name: N_('Highlighter'),
        hint: N_('Wide translucent stroke that lets the capture show through'),
        accel: 'key-tool-highlighter',
    },
    [ToolType.TEXT]: {
        icon: 'dos-text-symbolic',
        fallback: 'insert-text-symbolic',
        name: N_('Text'),
        hint: N_('Click, type, then press Enter to place the text'),
        accel: 'key-tool-text',
    },
    [ToolType.COUNTER]: {
        icon: 'dos-counter-symbolic',
        fallback: 'list-add-symbolic',
        name: N_('Counter'),
        hint: N_('Each click drops the next number in the sequence'),
        accel: 'key-tool-counter',
    },
    [ToolType.PIXELATE]: {
        icon: 'dos-pixelate-symbolic',
        fallback: 'view-grid-symbolic',
        name: N_('Pixelate'),
        hint: N_('Drag over a region to hide it in the saved image'),
        accel: 'key-tool-pixelate',
    },
};

export const DrawingToolbar = GObject.registerClass({
    GTypeName: 'ScreenshotDrawingToolbar',
    Signals: {
        'color-popover-toggled': {},
    },
}, class DrawingToolbar extends St.BoxLayout {
    /**
     * @param {DrawingModel} model
     * @param {string|null} iconsPath Ruta al directorio `icons/` de la extensión.
     * @param {object} prefs Preferencias ya leídas de GSettings.
     * @param {TooltipManager|null} tooltips
     * @param {object} params
     */
    _init(model, iconsPath = null, prefs = {}, tooltips = null, params = {}) {
        super._init({
            style_class: 'screenshot-ui-panel screenshot-draw-toolbar bms-popup-blur-target',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            y_expand: false,
            reactive: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
            ...params,
        });

        this._model = model;
        this._iconsPath = iconsPath;
        this._prefs = prefs;
        this._tooltips = tooltips;
        this._shortcuts = prefs.shortcuts ?? {};
        this._toolButtons = new Map();
        this._colorPopover = null;
        this._colorButton = null;
        this._colorPreviewSwatch = null;
        this._fillButton = null;
        this._sizeLabel = null;
        this._undoBtn = null;
        this._redoBtn = null;

        this._buildUI();

        this._modelListener = () => this._syncState();
        this._model.addListener(this._modelListener);
        this._syncState();
    }

    /**
     * Construye un St.Icon usando el SVG propio de la extensión cuando existe,
     * y cayendo al icono del tema si no.
     */
    _makeIcon(customName, themeFallback, size) {
        if (this._iconsPath && customName) {
            const path = GLib.build_filenamev([this._iconsPath, `${customName}.svg`]);
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) {
                return new St.Icon({
                    gicon: new Gio.FileIcon({ file }),
                    icon_size: size,
                });
            }
        }
        return new St.Icon({ icon_name: themeFallback, icon_size: size });
    }

    _createSeparator() {
        return new St.Widget({
            style_class: 'screenshot-draw-separator',
        });
    }

    /** `Nombre (Atajo)\nQué hace`, omitiendo el atajo si está desactivado. */
    _tooltipText(name, hint, accelKey) {
        const accel = describeAccelerator(this._shortcuts[accelKey]);
        const title = accel ? `${name} (${accel})` : name;
        return hint ? `${title}\n${hint}` : title;
    }

    _makeButton({ styleClass, iconName, iconFallback, iconSize = 16, tooltip, toggle = false, onClick }) {
        const btn = new St.Button({
            style_class: styleClass,
            can_focus: true,
            track_hover: true,
            toggle_mode: toggle,
            accessible_name: tooltip.replace('\n', ' — '),
        });

        btn.set_child(this._makeIcon(iconName, iconFallback, iconSize));
        btn.connect('clicked', onClick);
        this._tooltips?.attach(btn, tooltip);
        return btn;
    }

    _buildUI() {
        // --- 1. Herramientas ---
        // El orden y la presencia los decide `enabled-tools`; se filtra contra
        // el orden canónico para que un valor inventado en GSettings no rompa
        // la barra ni cree un botón sin icono.
        const requested = Array.isArray(this._prefs.enabledTools)
            ? this._prefs.enabledTools
            : ToolOrder;
        const tools = requested.filter(id => ToolOrder.includes(id) && TOOL_INFO[id]);

        for (const id of tools) {
            const info = TOOL_INFO[id];
            const btn = this._makeButton({
                styleClass: 'screenshot-draw-tool-button',
                iconName: info.icon,
                iconFallback: info.fallback,
                tooltip: this._tooltipText(_(info.name), _(info.hint), info.accel),
                toggle: true,
                onClick: () => this._model.toggleTool(id),
            });

            this.add_child(btn);
            this._toolButtons.set(id, btn);
        }

        if (tools.length > 0) {
            this.add_child(this._createSeparator());
        }

        // --- 2. Selector de color: botón compacto + paleta desplegable ---
        if (this._prefs.showColorPicker !== false) {
            const colorBtn = new St.Button({
                style_class: 'screenshot-draw-color-picker-btn',
                can_focus: true,
                track_hover: true,
                accessible_name: _('Colour'),
            });

            this._colorPreviewSwatch = new St.Widget({
                style_class: 'screenshot-draw-color-swatch',
            });
            colorBtn.set_child(this._colorPreviewSwatch);
            this._tooltips?.attach(colorBtn, this._tooltipText(
                _('Colour'), _('Open the palette; the shortcut cycles through it'),
                'key-cycle-color'));

            this._colorButton = colorBtn;

            // Se construye aquí pero NO se añade a la barra: el patcher lo cuelga
            // del stage y lo posiciona, para que abrirlo no reacomode la barra.
            this._colorPopover = new St.BoxLayout({
                style_class: 'screenshot-ui-panel screenshot-draw-color-popover bms-popup-blur-target',
                orientation: Clutter.Orientation.HORIZONTAL,
                visible: false,
                reactive: true,
                offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
            });

            for (const color of this._model.palette) {
                const swatchBtn = new St.Button({
                    style_class: 'screenshot-draw-popover-color-btn',
                    style: `background-color: ${color.hex};`,
                    can_focus: true,
                    track_hover: true,
                    accessible_name: color.hex,
                });

                swatchBtn.connect('clicked', () => {
                    this._model.setActiveColor(color);
                    this._colorPopover.visible = false;
                });

                this._colorPopover.add_child(swatchBtn);
            }

            colorBtn.connect('clicked', () => {
                this._colorPopover.visible = !this._colorPopover.visible;
                this._tooltips?.hide();
                this.emit('color-popover-toggled');
            });

            this.add_child(colorBtn);
        }

        // --- 3. Relleno de figuras ---
        if (this._prefs.showFillToggle !== false) {
            this._fillButton = this._makeButton({
                styleClass: 'screenshot-draw-tool-button',
                iconName: 'dos-fill-symbolic',
                iconFallback: 'format-justify-fill-symbolic',
                tooltip: this._tooltipText(
                    _('Fill'),
                    _('Draw rectangles and ellipses filled instead of outlined'),
                    'key-toggle-fill'),
                toggle: true,
                onClick: () => this._model.toggleFill(),
            });
            this.add_child(this._fillButton);
        }

        if (this._colorButton || this._fillButton) {
            this.add_child(this._createSeparator());
        }

        // --- 4. Grosor de trazo ---
        if (this._prefs.showSizeStepper !== false) {
            const sizeContainer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'screenshot-draw-size-stepper',
                reactive: true,
            });

            const decBtn = this._makeButton({
                styleClass: 'screenshot-draw-stepper-btn',
                iconName: null,
                iconFallback: 'value-decrease-symbolic',
                iconSize: 14,
                tooltip: this._tooltipText(
                    _('Thinner stroke'),
                    _('Also Ctrl + scroll wheel anywhere on screen'),
                    'key-decrease-size'),
                onClick: () => this._model.decreaseSize(),
            });

            this._sizeLabel = new St.Label({
                text: `${this._model.activeWidth}px`,
                style_class: 'screenshot-draw-size-label',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });

            const incBtn = this._makeButton({
                styleClass: 'screenshot-draw-stepper-btn',
                iconName: null,
                iconFallback: 'value-increase-symbolic',
                iconSize: 14,
                tooltip: this._tooltipText(
                    _('Thicker stroke'),
                    _('Also Ctrl + scroll wheel anywhere on screen'),
                    'key-increase-size'),
                onClick: () => this._model.increaseSize(),
            });

            sizeContainer.connect('scroll-event', (actor, event) => {
                const dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.UP) {
                    this._model.increaseSize();
                    return Clutter.EVENT_STOP;
                } else if (dir === Clutter.ScrollDirection.DOWN) {
                    this._model.decreaseSize();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            sizeContainer.add_child(decBtn);
            sizeContainer.add_child(this._sizeLabel);
            sizeContainer.add_child(incBtn);
            this.add_child(sizeContainer);
            this.add_child(this._createSeparator());
        }

        // --- 5. Deshacer / Rehacer / Limpiar ---
        if (this._prefs.showUndoRedo !== false) {
            this._undoBtn = this._makeButton({
                styleClass: 'screenshot-draw-tool-button',
                iconName: null,
                iconFallback: 'edit-undo-symbolic',
                tooltip: this._tooltipText(
                    _('Undo'), _('Remove the last annotation'), 'key-undo'),
                onClick: () => this._model.undo(),
            });
            this.add_child(this._undoBtn);

            this._redoBtn = this._makeButton({
                styleClass: 'screenshot-draw-tool-button',
                iconName: null,
                iconFallback: 'edit-redo-symbolic',
                tooltip: this._tooltipText(
                    _('Redo'), _('Put back the annotation you just undid'), 'key-redo'),
                onClick: () => this._model.redo(),
            });
            this.add_child(this._redoBtn);
        }

        if (this._prefs.showClear !== false) {
            this.add_child(this._makeButton({
                styleClass: 'screenshot-draw-tool-button',
                iconName: null,
                iconFallback: 'edit-clear-symbolic',
                tooltip: this._tooltipText(
                    _('Clear all'), _('Remove every annotation; undo brings them back'),
                    'key-clear'),
                onClick: () => this._model.clear(),
            }));
        }

        // Un separador final queda huérfano si el último grupo está oculto.
        this._trimTrailingSeparator();
    }

    _trimTrailingSeparator() {
        const children = this.get_children();
        const last = children[children.length - 1];
        if (last?.has_style_class_name?.('screenshot-draw-separator')) {
            this.remove_child(last);
            last.destroy();
        }
    }

    get colorPopover() {
        return this._colorPopover;
    }

    get colorButton() {
        return this._colorButton;
    }

    /** ¿Está desplegada la paleta de colores? */
    get isPopoverOpen() {
        return this._colorPopover?.visible === true;
    }

    /** Oculta la paleta desplegable, si está abierta. */
    closePopover() {
        if (this._colorPopover) {
            this._colorPopover.visible = false;
        }
    }

    _syncState() {
        for (const [id, btn] of this._toolButtons) {
            btn.set_checked(this._model.activeTool === id);
        }

        if (this._fillButton) {
            this._fillButton.set_checked(this._model.fillShapes);
        }

        if (this._colorPreviewSwatch) {
            this._colorPreviewSwatch.set_style(`background-color: ${this._model.activeColor.hex};`);
        }

        if (this._sizeLabel) {
            this._sizeLabel.set_text(`${this._model.activeWidth}px`);
        }

        if (this._undoBtn) {
            this._undoBtn.reactive = this._model.canUndo();
            this._undoBtn.opacity = this._model.canUndo() ? 255 : 90;
        }

        if (this._redoBtn) {
            this._redoBtn.reactive = this._model.canRedo();
            this._redoBtn.opacity = this._model.canRedo() ? 255 : 90;
        }
    }

    destroy() {
        if (this._colorPopover) {
            this._colorPopover.get_parent()?.remove_child(this._colorPopover);
            this._colorPopover.destroy();
            this._colorPopover = null;
        }
        if (this._model && this._modelListener) {
            this._model.removeListener(this._modelListener);
            this._modelListener = null;
        }
        super.destroy();
    }
});
