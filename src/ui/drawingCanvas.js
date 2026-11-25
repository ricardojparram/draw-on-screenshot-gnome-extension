import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import { ToolType } from '../core/drawingModel.js';
import { luminance } from '../core/settings.js';
import { logError } from '../core/log.js';

/** Desplazamiento de la sombra bajo el trazo, en px lógicos. */
const SHADOW_OFFSET = 1.5;
const SHADOW_ALPHA = 0.45;

/** Herramientas a las que una sombra no aporta nada o directamente estorba. */
const NO_SHADOW_TOOLS = new Set([ToolType.HIGHLIGHTER, ToolType.PIXELATE]);

/** Lado del bloque de pixelado cuando el trazo no trae uno propio, en px lógicos. */
const DEFAULT_PIXELATE_BLOCK = 4;

/** Holgura alrededor de una anotación de texto para agarrarla con el ratón. */
const TEXT_GRAB_PADDING = 6;

/**
 * Renderiza un trazo sobre un contexto de Cairo.
 * Función pura, reutilizada por la UI en vivo y por el compositor final.
 *
 * Sistemas de coordenadas — importante:
 *   - Los puntos del trazo (`stroke`) están SIEMPRE en coordenadas lógicas del stage.
 *   - `scale` convierte de coordenadas lógicas a píxeles de buffer (HiDPI).
 *   - `offsetX` / `offsetY` son el origen del destino, ya en PÍXELES DE BUFFER
 *     (así los devuelve `ScreenshotUI._getSelectedGeometry(true)`).
 *
 * De ahí que la transformación correcta sea `punto * scale - offset`, y no
 * `(punto - offset) * scale`: mezclar ambos espacios desplazaba el dibujo en
 * pantallas HiDPI.
 *
 * @param {object} opts
 * @param {boolean} opts.preview
 *   `true` mientras se pinta en pantalla. El pixelado sólo tiene vista previa
 *   aquí: la censura real la aplica el compositor sobre el pixbuf capturado,
 *   porque desde JS no se pueden leer los píxeles de la pantalla.
 */
export function renderStroke(cr, stroke, scale = 1.0, offsetX = 0, offsetY = 0, opts = {}) {
    if (!stroke) return;

    const { preview = false, isShadow = false } = opts;

    if (stroke.tool === ToolType.PIXELATE) {
        if (preview && !isShadow) {
            renderPixelatePreview(cr, stroke, scale, offsetX, offsetY, opts.pixelateMode);
        }
        return;
    }

    // La sombra es el mismo trazo en negro translúcido, ligeramente desplazado.
    // Se pinta antes para que quede debajo.
    if (stroke.shadow && !isShadow && !NO_SHADOW_TOOLS.has(stroke.tool)) {
        cr.save();
        try {
            cr.translate(SHADOW_OFFSET * scale, SHADOW_OFFSET * scale);
            renderStroke(
                cr,
                { ...stroke, color: { r: 0, g: 0, b: 0, a: SHADOW_ALPHA } },
                scale, offsetX, offsetY,
                { ...opts, isShadow: true }
            );
        } finally {
            cr.restore();
        }
    }

    const { color, width, tool, points, start, end, text, x, y } = stroke;
    const scaledWidth = width * scale;

    const tx = px => px * scale - offsetX;
    const ty = py => py * scale - offsetY;

    cr.save();
    try {
        cr.setSourceRGBA(color.r, color.g, color.b, color.a ?? 1.0);
        cr.setLineWidth(scaledWidth);
        cr.setLineCap(cairo.LineCap.ROUND);
        cr.setLineJoin(cairo.LineJoin.ROUND);

        if (tool === ToolType.PEN || tool === ToolType.HIGHLIGHTER) {
            if (!points || points.length === 0) return;

            if (points.length === 1) {
                const p = points[0];
                cr.arc(tx(p.x), ty(p.y), scaledWidth / 2, 0, 2 * Math.PI);
                cr.fill();
            } else {
                cr.moveTo(tx(points[0].x), ty(points[0].y));
                for (let i = 1; i < points.length; i++) {
                    cr.lineTo(tx(points[i].x), ty(points[i].y));
                }
                cr.stroke();
            }
        } else if (tool === ToolType.LINE) {
            if (!start || !end) return;

            cr.moveTo(tx(start.x), ty(start.y));
            cr.lineTo(tx(end.x), ty(end.y));
            cr.stroke();
        } else if (tool === ToolType.RECT) {
            if (!start || !end) return;

            const rx = tx(Math.min(start.x, end.x));
            const ry = ty(Math.min(start.y, end.y));
            const rw = Math.abs(end.x - start.x) * scale;
            const rh = Math.abs(end.y - start.y) * scale;

            cr.rectangle(rx, ry, rw, rh);
            if (stroke.fill) {
                cr.fill();
            } else {
                cr.stroke();
            }
        } else if (tool === ToolType.ELLIPSE) {
            if (!start || !end) return;

            const cx = tx((start.x + end.x) / 2);
            const cy = ty((start.y + end.y) / 2);
            const rx = Math.abs(end.x - start.x) * scale / 2;
            const ry = Math.abs(end.y - start.y) * scale / 2;

            if (rx < 0.5 || ry < 0.5) return;

            // Cairo no tiene primitiva de elipse: se deforma un círculo unidad.
            // La transformación se deshace ANTES de trazar para que el grosor no
            // herede la deformación y el contorno salga de espesor uniforme.
            cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();

            if (stroke.fill) {
                cr.fill();
            } else {
                cr.stroke();
            }
        } else if (tool === ToolType.ARROW) {
            if (!start || !end) return;

            const sx = tx(start.x);
            const sy = ty(start.y);
            const ex = tx(end.x);
            const ey = ty(end.y);

            const dx = ex - sx;
            const dy = ey - sy;
            const length = Math.hypot(dx, dy);

            if (length < 2) return;

            const angle = Math.atan2(dy, dx);
            const baseHeadLength = Math.max(6 * scale, scaledWidth * 3.5);
            const headLength = Math.min(baseHeadLength, length / 0.9);
            const headAngle = Math.PI / 6; // 30 degrees

            // Punto base donde el cuerpo de la flecha se une a la cabeza
            const bx = ex - (headLength * 0.75) * Math.cos(angle);
            const by = ey - (headLength * 0.75) * Math.sin(angle);

            // Esquinas laterales de la punta
            const x1 = ex - headLength * Math.cos(angle - headAngle);
            const y1 = ey - headLength * Math.sin(angle - headAngle);
            const x2 = ex - headLength * Math.cos(angle + headAngle);
            const y2 = ey - headLength * Math.sin(angle + headAngle);

            // 1. Cuerpo, terminando exactamente en la base de la cabeza
            cr.moveTo(sx, sy);
            cr.lineTo(bx, by);
            cr.stroke();

            // 2. Cabeza sólida
            cr.newPath();
            cr.moveTo(ex, ey);
            cr.lineTo(x1, y1);
            cr.lineTo(bx, by);
            cr.lineTo(x2, y2);
            cr.closePath();
            cr.fill();
        } else if (tool === ToolType.TEXT) {
            if (!text) return;

            // `x`, `y` es la esquina SUPERIOR IZQUIERDA, no la línea base: es lo
            // que devuelve Pango y lo que coincide con el cuadro de entrada.
            cr.moveTo(tx(x), ty(y));
            PangoCairo.show_layout(cr, buildTextLayout(cr, stroke, scale));
        } else if (tool === ToolType.COUNTER) {
            renderCounter(cr, stroke, scale, tx(x), ty(y), isShadow);
        }
    } finally {
        // El path NO forma parte del estado gráfico: `cr.restore()` no lo
        // deshace. Texto y contador terminan con un `moveTo` sin consumir, y
        // `cairo_arc()` une el punto actual con el inicio del arco con una
        // RECTA, así que el siguiente círculo que se dibujara (el preview bajo
        // el cursor, o un punto suelto de lápiz) aparecía atado a la última
        // anotación por una línea fina. Vaciar el path lo corta de raíz.
        cr.newPath();
        cr.restore();
    }
}

/**
 * Prepara el `Pango.Layout` de una anotación de texto.
 *
 * El texto NO se dibuja con la API «de juguete» de Cairo (`selectFontFace` /
 * `showText`). Esa vía resuelve la familia por su cuenta y para «Sans» acaba
 * eligiendo una variante más gruesa que la que usa el resto del escritorio: el
 * texto salía en negrita aunque la preferencia estuviese desactivada. Pango es
 * además el mismo motor que pinta el cuadro de entrada, así que lo escrito y lo
 * estampado coinciden, y trae de serie el moldeado de escrituras complejas y de
 * los emoji, que `showText` no sabe hacer.
 */
function buildTextLayout(cr, stroke, scale = 1.0) {
    const layout = PangoCairo.create_layout(cr);

    const desc = Pango.FontDescription.new();
    desc.set_family(stroke.fontFamily || 'Sans');
    desc.set_weight(stroke.bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    // Tamaño ABSOLUTO: `set_size` habla en puntos y quedaría a merced de los
    // ppp del escritorio; aquí el tamaño ya está en píxeles lógicos.
    desc.set_absolute_size((stroke.fontSize || 22) * scale * Pango.SCALE);
    layout.set_font_description(desc);

    layout.set_text(stroke.text ?? '', -1);
    return layout;
}

/**
 * Tamaño en píxeles lógicos de una anotación de texto, para poder agarrarla con
 * el ratón. El resultado se memoriza en el propio trazo: medir exige montar un
 * contexto de Cairo y el texto ya no cambia una vez confirmado.
 *
 * @returns {{ width: number, height: number }}
 */
export function textStrokeSize(stroke) {
    if (!stroke?.text) return { width: 0, height: 0 };
    if (stroke._size) return stroke._size;

    const surface = new cairo.ImageSurface(cairo.Format.ARGB32, 1, 1);
    const cr = new cairo.Context(surface);
    try {
        const [, logical] = buildTextLayout(cr, stroke, 1.0).get_pixel_extents();
        stroke._size = { width: logical.width, height: logical.height };
    } catch (err) {
        logError('No se pudo medir una anotación de texto', err);
        stroke._size = { width: 0, height: 0 };
    } finally {
        cr.$dispose();
    }
    return stroke._size;
}

/**
 * Burbuja numerada estilo Flameshot: disco del color activo con el número
 * encima, en blanco o negro según cuál contraste mejor con el relleno.
 */
function renderCounter(cr, stroke, scale, cx, cy, isShadow) {
    const radius = (stroke.radius ?? 14) * scale;
    const label = String(stroke.value ?? 1);

    cr.arc(cx, cy, radius, 0, 2 * Math.PI);
    cr.fill();

    // La sombra sólo necesita la silueta del disco: pintar también el número en
    // negro translúcido lo emborronaría en vez de despegarlo del fondo.
    if (isShadow) return;

    const ink = luminance(stroke.color) > 0.6
        ? { r: 0, g: 0, b: 0 }
        : { r: 1, g: 1, b: 1 };

    cr.setSourceRGBA(ink.r, ink.g, ink.b, 1.0);
    cr.selectFontFace(
        stroke.fontFamily || 'Sans',
        cairo.FontSlant.NORMAL,
        cairo.FontWeight.BOLD
    );

    // El número ha de caber sea cual sea su número de cifras: se parte de un
    // tamaño proporcional al disco y se encoge hasta que las extensiones reales
    // quepan dentro del diámetro útil.
    let fontSize = radius * 1.25;
    let extents = null;
    for (let i = 0; i < 6; i++) {
        cr.setFontSize(fontSize);
        extents = cr.textExtents(label);
        if (extents.width <= radius * 1.6) break;
        fontSize *= 0.82;
    }

    cr.moveTo(
        cx - extents.width / 2 - extents.xBearing,
        cy - extents.height / 2 - extents.yBearing
    );
    cr.showText(label);
    // `showText` deja punto actual; se llama también desde el preview, fuera
    // del `finally` de `renderStroke` que lo limpia.
    cr.newPath();
}

/**
 * Vista previa del pixelado.
 *
 * En modo `overlay` no hay nada que pintar: el mosaico real lo pone
 * `PixelateLayer` con un shader sobre la pantalla congelada.
 *
 * El modo `mosaic` es el respaldo para cuando la interfaz de captura no expone
 * su imagen congelada: un mosaico gris con la misma retícula que aplicará el
 * compositor, que al menos deja elegir región y tamaño de bloque.
 */
function renderPixelatePreview(cr, stroke, scale, offsetX, offsetY, mode = 'mosaic') {
    // Con la capa GPU activa el mosaico ya delimita la región por sí mismo, así
    // que no se dibuja nada: un recuadro encima sólo ensuciaría la censura.
    if (mode === 'overlay') return;

    const { start, end } = stroke;
    if (!start || !end) return;

    const x0 = Math.min(start.x, end.x) * scale - offsetX;
    const y0 = Math.min(start.y, end.y) * scale - offsetY;
    const w = Math.abs(end.x - start.x) * scale;
    const h = Math.abs(end.y - start.y) * scale;
    if (w < 1 || h < 1) return;

    const block = Math.max(2, (stroke.block ?? DEFAULT_PIXELATE_BLOCK) * scale);

    cr.save();
    try {
        cr.rectangle(x0, y0, w, h);
        cr.clip();
        renderMosaicFallback(cr, x0, y0, w, h, block);
    } finally {
        cr.restore();
    }
}

/** Mosaico gris determinista; sólo se usa si no hay capa de pixelado real. */
function renderMosaicFallback(cr, x0, y0, w, h, block) {
        const cols = Math.ceil(w / block);
        const rows = Math.ceil(h / block);

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                // Ruido determinista: el mismo rectángulo produce siempre el
                // mismo mosaico, así la vista previa no parpadea al repintar.
                // Un módulo entero dibujaba diagonales muy visibles; el seno
                // rompe la regularidad sin dejar de ser reproducible.
                const seeded = Math.sin(row * 12.9898 + col * 78.233) * 43758.5453;
                const noise = seeded - Math.floor(seeded);
                const grey = 0.28 + noise * 0.44;
                cr.setSourceRGBA(grey, grey, grey, 1.0);
                cr.rectangle(x0 + col * block, y0 + row * block, block, block);
                cr.fill();
            }
        }
}

/**
 * Actor visual interactivo para pintar trazos.
 *
 * El actor NO cubre necesariamente todo el stage: el patcher lo recorta al área
 * seleccionada para que el selector de área siga siendo utilizable fuera de ella.
 * Los trazos se guardan en coordenadas del stage, así que al pintar en vivo hay
 * que restar la posición del propio actor.
 */
export const DrawingCanvas = GObject.registerClass({
    GTypeName: 'ScreenshotDrawingCanvas',
    Signals: {
        'draw-started': {},
        'draw-ended': {},
    },
}, class DrawingCanvas extends St.DrawingArea {
    _init(model, params = {}) {
        super._init({
            reactive: true,
            can_focus: true,
            ...params,
        });

        this._model = model;
        this._isDrawing = false;
        this._dragGrab = null;
        this._activeTextEntry = null;
        // Anotación de texto que se está reubicando con el ratón, si la hay.
        this._draggingText = null;
        this._pointerX = 0;
        this._pointerY = 0;
        this._pointerInside = false;
        // 'overlay': el mosaico real lo pone la capa GPU y aquí sólo va el borde.
        this._pixelatePreviewMode = 'mosaic';

        // Sin herramienta activa el lienzo debe ser INERTE, no sólo ignorar el
        // clic: Clutter entrega el evento al actor reactivo más alto, y devolver
        // EVENT_PROPAGATE lo pasa al padre, nunca al selector de área que está
        // debajo. Sólo dejando de ser reactivo el selector vuelve a recibirlo.
        this.reactive = this._model.hasActiveTool();
        this._syncCursor();

        this._modelListener = () => {
            this.reactive = this._model.hasActiveTool();
            this._syncCursor();
            // Si el modelo descartó el trazo en curso (deshacer, cambio de
            // herramienta), el gesto de arrastre deja de ser válido.
            if (this._isDrawing && !this._model.currentStroke) {
                this._isDrawing = false;
                this._releaseDragGrab();
            }
            if (this._draggingText &&
                !this._model.strokes.includes(this._draggingText.stroke)) {
                this._draggingText = null;
                this._releaseDragGrab();
            }
            this.queue_repaint();
        };
        this._model.addListener(this._modelListener);

        this.connect('repaint', this._onRepaint.bind(this));
    }

    _onRepaint(area) {
        const cr = area.get_context();
        if (!cr) return;

        try {
            // Origen del actor en coordenadas del stage: los trazos se guardan
            // en ese espacio, y Cairo pinta en coordenadas locales del actor.
            const [ox, oy] = area.get_transformed_position();
            const offsetX = Number.isFinite(ox) ? ox : 0;
            const offsetY = Number.isFinite(oy) ? oy : 0;

            cr.save();
            cr.setOperator(cairo.Operator.CLEAR);
            cr.paint();
            cr.restore();

            const opts = { preview: true, pixelateMode: this._pixelatePreviewMode };

            for (const stroke of this._model.strokes) {
                renderStroke(cr, stroke, 1.0, offsetX, offsetY, opts);
            }

            if (this._model.currentStroke) {
                renderStroke(cr, this._model.currentStroke, 1.0, offsetX, offsetY, opts);
            }

            this._renderToolPreview(cr, offsetX, offsetY);
        } catch (err) {
            logError('Fallo al repintar el lienzo', err);
        }
    }

    /**
     * Anticipo bajo el cursor de lo que va a dibujarse: el grosor del trazo al
     * estilo de Flameshot, o el número que recibirá la próxima burbuja.
     */
    _renderToolPreview(cr, offsetX, offsetY) {
        if (!this._pointerInside || this._isDrawing) return;
        if (!this._model.hasActiveTool()) return;

        const tool = this._model.activeTool;
        if (tool === ToolType.TEXT) return;

        const cx = this._pointerX - offsetX;
        const cy = this._pointerY - offsetY;

        // Por si el contexto llega con un punto actual de algún trazo previo:
        // `cairo_arc()` lo enlazaría con una recta hasta el círculo.
        cr.newPath();

        if (tool === ToolType.COUNTER) {
            cr.save();
            try {
                const c = this._model.activeColor;
                cr.setSourceRGBA(c.r, c.g, c.b, 0.55);
                renderCounter(
                    cr,
                    {
                        value: this._model.nextCounterValue(),
                        color: this._model.activeColor,
                        radius: this._model.counterRadius(),
                        fontFamily: this._model.fontFamily,
                    },
                    1.0, cx, cy, false
                );
            } finally {
                cr.restore();
            }
            return;
        }

        const isHighlighter = tool === ToolType.HIGHLIGHTER;
        const width = isHighlighter ? this._model.activeWidth * 3.5 : this._model.activeWidth;
        const radius = tool === ToolType.PIXELATE
            ? Math.max(this._model.pixelateBlock / 2, 3)
            : Math.max(width / 2, 1.5);

        cr.save();
        try {
            const color = this._model.activeColor;

            cr.setLineWidth(1);

            cr.setSourceRGBA(0, 0, 0, 0.55);
            cr.arc(cx, cy, radius + 1, 0, 2 * Math.PI);
            cr.stroke();

            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            // Punto central con el color activo, para saber con qué se pinta.
            cr.setSourceRGBA(color.r, color.g, color.b, 0.85);
            cr.arc(cx, cy, 1.5, 0, 2 * Math.PI);
            cr.fill();
        } finally {
            cr.restore();
        }
    }

    /** Estado de Mayús y Ctrl tal y como lo espera `DrawingModel.updateStroke`. */
    _modifiersFrom(event) {
        const state = event.get_state();
        return {
            shift: (state & Clutter.ModifierType.SHIFT_MASK) !== 0,
            ctrl: (state & Clutter.ModifierType.CONTROL_MASK) !== 0,
        };
    }

    vfunc_enter_event(event) {
        this._pointerInside = true;
        const [x, y] = event.get_coords();
        this._pointerX = x;
        this._pointerY = y;
        this.queue_repaint();
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event() {
        this._pointerInside = false;
        this.queue_repaint();
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
        if (!this._model.hasActiveTool()) {
            return Clutter.EVENT_PROPAGATE;
        }

        if (event.get_button() === Clutter.BUTTON_PRIMARY) {
            const [x, y] = event.get_coords();

            if (this._activeTextEntry) {
                this._commitTextEntry();
                return Clutter.EVENT_STOP;
            }

            const tool = this._model.activeTool;

            if (tool === ToolType.TEXT) {
                // Pulsar SOBRE un texto ya escrito lo mueve; sólo el clic en
                // hueco abre un cuadro nuevo.
                const target = this._textStrokeAt(x, y);
                if (target) {
                    this._draggingText = {
                        stroke: target,
                        dx: x - target.x,
                        dy: y - target.y,
                    };
                    this._acquireDragGrab();
                    this.emit('draw-started');
                    return Clutter.EVENT_STOP;
                }

                this._spawnTextEntry(x, y);
                return Clutter.EVENT_STOP;
            }

            if (tool === ToolType.COUNTER) {
                this._model.addCounterStroke(x, y);
                return Clutter.EVENT_STOP;
            }

            this._isDrawing = true;
            this._acquireDragGrab();
            this.emit('draw-started');
            this._model.startStroke(x, y);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
        const [x, y] = event.get_coords();
        const moved = Math.abs(x - this._pointerX) >= 1 || Math.abs(y - this._pointerY) >= 1;
        this._pointerX = x;
        this._pointerY = y;
        this._pointerInside = true;

        if (this._draggingText) {
            const { stroke, dx, dy } = this._draggingText;
            this._model.moveStroke(stroke, x - dx, y - dy);
            return Clutter.EVENT_STOP;
        }

        if (this._isDrawing) {
            this._model.updateStroke(x, y, this._modifiersFrom(event));
            return Clutter.EVENT_STOP;
        }

        // Repintar sólo si el preview se movió de verdad: el lienzo cubre toda
        // la pantalla y repintar por cada evento sub-pixel es caro.
        if (moved && this._model.hasActiveTool()) {
            this.queue_repaint();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        if (event.get_button() === Clutter.BUTTON_PRIMARY && this._draggingText) {
            this._draggingText = null;
            this._releaseDragGrab();
            this.emit('draw-ended');
            return Clutter.EVENT_STOP;
        }

        if (event.get_button() === Clutter.BUTTON_PRIMARY && this._isDrawing) {
            this._isDrawing = false;
            this._releaseDragGrab();
            this._model.endStroke();
            this.emit('draw-ended');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        const [x, y] = event.get_coords();
        this._pointerX = x;
        this._pointerY = y;
        this._pointerInside = true;

        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP) {
            this._model.increaseSize();
            return Clutter.EVENT_STOP;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            this._model.decreaseSize();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {'overlay'|'mosaic'} mode Quién dibuja la vista previa del pixelado.
     */
    setPixelatePreviewMode(mode) {
        this._pixelatePreviewMode = mode === 'overlay' ? 'overlay' : 'mosaic';
        this.queue_repaint();
    }

    /** Reposiciona el preview del pincel desde fuera (p. ej. Ctrl + rueda). */
    setPointer(x, y) {
        this._pointerX = x;
        this._pointerY = y;
        this._pointerInside = true;
        this.queue_repaint();
    }

    /**
     * Anotación de texto bajo un punto del stage, o `null`. Se recorre de atrás
     * hacia delante para que, con textos superpuestos, agarre el de encima, que
     * es el que se ve.
     */
    _textStrokeAt(x, y) {
        const strokes = this._model.strokes;
        for (let i = strokes.length - 1; i >= 0; i--) {
            const stroke = strokes[i];
            if (stroke.tool !== ToolType.TEXT) continue;

            const { width, height } = textStrokeSize(stroke);
            if (width <= 0 || height <= 0) continue;

            if (x >= stroke.x - TEXT_GRAB_PADDING &&
                x <= stroke.x + width + TEXT_GRAB_PADDING &&
                y >= stroke.y - TEXT_GRAB_PADDING &&
                y <= stroke.y + height + TEXT_GRAB_PADDING) {
                return stroke;
            }
        }
        return null;
    }

    get hasTextEntry() {
        return this._activeTextEntry !== null;
    }

    isTextEntryTarget(actor) {
        const entry = this._activeTextEntry?.entry;
        return Boolean(entry && actor && (actor === entry || entry.contains(actor)));
    }

    _syncCursor() {
        if (typeof this.set_cursor_type !== 'function') return;
        const tool = this._model.activeTool;
        if (!tool) {
            this.set_cursor_type(Clutter.CursorType.INHERIT);
        } else if (tool === ToolType.TEXT) {
            this.set_cursor_type(Clutter.CursorType.TEXT);
        } else {
            this.set_cursor_type(Clutter.CursorType.CROSSHAIR);
        }
    }

    _acquireDragGrab() {
        if (this._dragGrab) return;
        try {
            if (typeof global?.stage?.grab === 'function') {
                this._dragGrab = global.stage.grab(this);
            }
        } catch (e) {
            this._dragGrab = null;
        }
    }

    _releaseDragGrab() {
        if (!this._dragGrab) return;
        try {
            this._dragGrab.dismiss();
        } catch (e) {
            // ignore already-dismissed grabs
        }
        this._dragGrab = null;
    }

    /** Release any active pointer drag or grab safely. */
    cancelDrag() {
        this._isDrawing = false;
        this._draggingText = null;
        this._releaseDragGrab();
    }

    _spawnTextEntry(x, y) {
        const fontSize = Math.max(18, this._model.activeWidth * 3.5);
        const color = this._model.activeColor.hex || '#e01b24';
        // El peso ha de fijarse explícitamente: sin él la entrada hereda la
        // negrita del tema y lo escrito no coincide con lo que se estampa.
        const weight = this._model.textBold ? 'bold' : 'normal';
        const family = this._model.fontFamily || 'Sans';

        const entry = new St.Entry({
            style_class: 'screenshot-draw-text-entry',
            // La familia va entrecomillada: sin comillas, un nombre con
            // espacios («DejaVu Sans») rompe la declaración CSS de St.
            style: `font-size: ${fontSize}px; color: ${color}; ` +
                   `font-weight: ${weight}; font-family: "${family}";`,
            can_focus: true,
        });

        const parent = this.get_parent();
        if (!parent) return;

        entry.set_position(x, y);
        parent.add_child(entry);
        entry.grab_key_focus();

        const dismiss = () => {
            // Soltar el foco ANTES de destruir. Si desaparece el actor que lo
            // tiene, la capa de accesibilidad sale a buscar su padre y se
            // encuentra con un objeto ya liberado (Clutter/Atk-CRITICAL).
            const focus = global.stage.get_key_focus();
            if (focus && (focus === entry || entry.contains(focus))) {
                global.stage.set_key_focus(null);
            }

            if (entry.get_parent()) {
                entry.get_parent().remove_child(entry);
            }
            entry.destroy();
            this._activeTextEntry = null;
        };

        const commit = () => {
            const txt = entry.get_text();
            if (txt && txt.trim().length > 0) {
                // El texto no empieza en la esquina del St.Entry: el borde y el
                // relleno que le pone el tema lo meten unos píxeles hacia dentro,
                // y estampar en `x, y` a secas desplazaba la anotación respecto a
                // lo que se acababa de escribir. El desfase se MIDE sobre los
                // actores en vez de suponerlo, así que sigue siendo correcto si
                // el tema cambia. Sin asignar todavía, ambas posiciones son 0 y
                // el desfase sale 0, que es el comportamiento anterior.
                const [inkX, inkY] = this._textEntryInset(entry);
                this._model.addTextStroke(x + inkX, y + inkY, txt);
            }
            dismiss();
        };

        entry.clutter_text.connect('activate', commit);
        entry.clutter_text.connect('key-press-event', (actor, keyEvent) => {
            if (keyEvent.get_key_symbol() === Clutter.KEY_Escape) {
                dismiss();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._activeTextEntry = { entry, commit, dismiss };
    }

    /**
     * Desplazamiento del texto respecto a la esquina del cuadro de entrada, en
     * píxeles lógicos.
     *
     * @returns {[number, number]}
     */
    _textEntryInset(entry) {
        const inner = entry?.clutter_text;
        if (!inner) return [0, 0];

        const [ex, ey] = entry.get_transformed_position();
        const [cx, cy] = inner.get_transformed_position();
        if (![ex, ey, cx, cy].every(Number.isFinite)) return [0, 0];

        return [cx - ex, cy - ey];
    }

    _commitTextEntry() {
        if (this._activeTextEntry) {
            this._activeTextEntry.commit();
        }
    }

    /** Cierra la entrada de texto abierta sin guardar nada. */
    cancelTextEntry() {
        if (this._activeTextEntry) {
            this._activeTextEntry.dismiss();
        }
    }

    destroy() {
        this.cancelDrag();
        if (this._activeTextEntry) {
            this._activeTextEntry.dismiss();
        }
        if (this._model && this._modelListener) {
            this._model.removeListener(this._modelListener);
            this._modelListener = null;
        }
        super.destroy();
    }
});
