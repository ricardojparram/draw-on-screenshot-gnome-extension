import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ToolType } from '../core/drawingModel.js';
import { logWarning } from '../core/log.js';
import { PixelateEffect } from './pixelateEffect.js';

/**
 * Pixelado en vivo de la pantalla congelada.
 *
 * El mosaico NO se pinta encima: se transforma la propia imagen de debajo, como
 * en iOS o WhatsApp. Desde JS no se pueden leer los píxeles del stage, así que
 * en lugar de calcular el mosaico se le pide a la GPU que lo haga.
 *
 * La interfaz de captura congela la pantalla en `ScreenshotUI._stageScreenshot`,
 * un actor con un `Clutter.Content` que se puede compartir con otros actores.
 * Cada región crea entonces:
 *
 *   contenedor recortado a la región
 *     └── actor del tamaño del stage con ESE mismo contenido, desplazado −x,−y
 *
 * y sobre el contenedor va un `PixelateEffect`: Clutter pinta el subárbol en
 * una textura fuera de pantalla del tamaño de la región y el snippet GLSL
 * cuantiza las coordenadas de muestreo, que es literalmente pixelar.
 *
 * La retícula se alinea con la región, igual que hace `ScreenshotCompositor`
 * sobre el pixbuf, de modo que la vista previa y la imagen guardada coinciden.
 */

const PixelateRegion = GObject.registerClass({
    GTypeName: 'ScreenshotPixelateRegion',
}, class PixelateRegion extends St.Widget {
    _init(content, stageWidth, stageHeight) {
        super._init({
            style_class: 'screenshot-draw-pixelate-region',
            // Sin layout manager explícito un St.Widget no asigna a sus hijos y
            // el actor interior se queda con una asignación infinita, es decir,
            // sin pintar. FixedLayout respeta la posición y el tamaño que se les
            // fija a mano, que es justo lo que se necesita aquí.
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            reactive: false,
        });

        this._inner = new St.Widget({
            content,
            width: stageWidth,
            height: stageHeight,
            reactive: false,
        });
        this.add_child(this._inner);

        this._effect = new PixelateEffect();
        this.add_effect(this._effect);

        this._blocksX = -1;
        this._blocksY = -1;
    }

    /**
     * @param {{x: number, y: number, width: number, height: number}} rect
     *   Región en coordenadas lógicas del stage.
     * @param {number} block Lado del bloque, en píxeles lógicos.
     */
    setRegion(rect, block) {
        this.set_position(rect.x, rect.y);
        this.set_size(rect.width, rect.height);
        this._inner.set_position(-rect.x, -rect.y);

        const size = Math.max(2, block);
        const blocksX = Math.max(1, Math.round(rect.width / size));
        const blocksY = Math.max(1, Math.round(rect.height / size));

        // Reenviar el uniforme sólo cuando cambia de verdad: durante un arrastre
        // esto se llama en cada evento de movimiento.
        if (blocksX !== this._blocksX || blocksY !== this._blocksY) {
            this._blocksX = blocksX;
            this._blocksY = blocksY;
            this._effect.setBlocks(blocksX, blocksY);
        }

        this._effect.queue_repaint();
    }
});

/**
 * Mantiene un actor de pixelado por cada trazo de la herramienta, reutilizando
 * los que ya existen en vez de crear y destruir en cada repintado.
 */
export class PixelateLayer {
    constructor(model) {
        this._model = model;
        this._container = null;
        this._regions = [];
        this._content = null;
        this._stageWidth = 0;
        this._stageHeight = 0;
        this._available = false;
    }

    get available() {
        return this._available;
    }

    /** Actor al que se cuelgan las regiones. Debe ir bajo el lienzo de dibujo. */
    get actor() {
        return this._container;
    }

    /**
     * Crea el contenedor. Se llama una sola vez, al construir la interfaz.
     *
     * @returns {Clutter.Actor|null}
     */
    build() {
        this._container = new St.Widget({
            style_class: 'screenshot-draw-pixelate-layer',
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            x_expand: false,
            y_expand: false,
        });
        this._container.visible = false;
        return this._container;
    }

    /**
     * Toma la imagen congelada de la interfaz de captura. Hay que llamarlo cada
     * vez que se abre, porque el contenido se renueva con cada captura.
     */
    refreshSource() {
        const ui = Main.screenshotUI;
        const content = ui?._stageScreenshot?.get_content?.() ?? null;

        if (!content || !PixelateEffect) {
            // Sin la imagen congelada o sin el efecto no hay forma de pixelar
            // en vivo: el lienzo dibuja entonces el mosaico gris de respaldo.
            this._available = false;
            this._content = null;
            if (!content) {
                logWarning('ScreenshotUI no expone la captura congelada; ' +
                           'la vista previa del pixelado será aproximada.');
            }
            this._clearRegions();
            return;
        }

        if (content !== this._content) {
            // El contenido cambió: los actores existentes muestran el anterior.
            this._clearRegions();
            this._content = content;
        }

        this._stageWidth = global.stage.width;
        this._stageHeight = global.stage.height;
        this._available = true;

        if (this._container) {
            this._container.set_position(0, 0);
            this._container.set_size(this._stageWidth, this._stageHeight);
            this._container.visible = true;
        }
    }

    /** Sincroniza los actores con los trazos de pixelado del modelo. */
    sync() {
        if (!this._available || !this._container) return;

        const strokes = [
            ...this._model.strokes.filter(s => s.tool === ToolType.PIXELATE),
        ];
        if (this._model.currentStroke?.tool === ToolType.PIXELATE) {
            strokes.push(this._model.currentStroke);
        }

        while (this._regions.length > strokes.length) {
            const region = this._regions.pop();
            this._container.remove_child(region);
            region.destroy();
        }

        strokes.forEach((stroke, index) => {
            const rect = rectOf(stroke);
            if (!rect) return;

            let region = this._regions[index];
            if (!region) {
                region = new PixelateRegion(
                    this._content, this._stageWidth, this._stageHeight);
                this._container.add_child(region);
                this._regions[index] = region;
            }

            region.setRegion(rect, stroke.block ?? 4);
            region.visible = rect.width >= 2 && rect.height >= 2;
        });
    }

    _clearRegions() {
        for (const region of this._regions) {
            region.get_parent()?.remove_child(region);
            region.destroy();
        }
        this._regions = [];
    }

    hide() {
        this._clearRegions();
        if (this._container) this._container.visible = false;
    }

    destroy() {
        this._clearRegions();
        if (this._container) {
            this._container.get_parent()?.remove_child(this._container);
            this._container.destroy();
            this._container = null;
        }
        this._content = null;
    }
}

/** Rectángulo normalizado de un trazo de pixelado, en coordenadas del stage. */
function rectOf(stroke) {
    const { start, end } = stroke;
    if (!start || !end) return null;
    return {
        x: Math.round(Math.min(start.x, end.x)),
        y: Math.round(Math.min(start.y, end.y)),
        width: Math.round(Math.abs(end.x - start.x)),
        height: Math.round(Math.abs(end.y - start.y)),
    };
}
