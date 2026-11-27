import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import { logError } from '../core/log.js';

/**
 * Efecto de GPU que pixela lo que pinta el actor al que se aplica.
 *
 * El fragment shader vuelve a muestrear la textura en el CENTRO del bloque al
 * que pertenece cada píxel, de modo que todo el bloque toma el mismo color. Eso
 * es exactamente pixelar, y lo hace la GPU sin copiar nada.
 *
 * Se usa el enganche `FRAGMENT` y se muestrea a mano porque el código se añade
 * DESPUÉS del muestreo por defecto: tocar `cogl_tex_coord` en ese punto ya no
 * cambiaría nada.
 *
 * La clase base depende de la versión de GNOME Shell:
 *
 *   - 48–50: `Shell.GLSLEffect`. `Clutter.ShaderEffect` no se puede construir
 *     desde JS porque mutter dejó de exponer `ClutterShaderType`.
 *   - 51+: `Shell.GLSLEffect` desaparece y `Clutter.ShaderEffect` pasa a
 *     aceptar un `Cogl.Snippet` estático, que es lo que usa el propio Shell.
 */
const PIXELATE_DECLARATIONS = 'uniform vec2 blocks;';
const PIXELATE_CODE = `
    vec2 uv = cogl_tex_coord0_in.xy;
    uv = (floor(uv * blocks) + vec2(0.5)) / blocks;
    cogl_color_out = texture2D(cogl_sampler0, uv) * cogl_color_in;
`;

const GTYPE_NAME = 'ScreenshotPixelateEffect';

function defineGLSLEffect() {
    return GObject.registerClass({
        GTypeName: GTYPE_NAME,
    }, class PixelateEffect extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                PIXELATE_DECLARATIONS,
                PIXELATE_CODE,
                false
            );
        }

        /** @param {number} x @param {number} y Número de bloques en cada eje. */
        setBlocks(x, y) {
            this.set_uniform_float(this.get_uniform_location('blocks'), 2, [x, y]);
        }
    });
}

function defineShaderEffect() {
    return GObject.registerClass({
        GTypeName: GTYPE_NAME,
    }, class PixelateEffect extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(
                Cogl.SnippetHook.FRAGMENT,
                PIXELATE_DECLARATIONS,
                PIXELATE_CODE
            );
        }

        /** @param {number} x @param {number} y Número de bloques en cada eje. */
        setBlocks(x, y) {
            this.set_uniform_float('blocks', 2, [x, y]);
        }
    });
}

function definePixelateEffect() {
    try {
        return Shell.GLSLEffect ? defineGLSLEffect() : defineShaderEffect();
    } catch (e) {
        // Sin efecto el lienzo dibuja el mosaico de respaldo: mejor perder la
        // vista previa que impedir que la extensión cargue.
        logError('No se pudo registrar el efecto de pixelado', e);
        return null;
    }
}

/** Clase del efecto, o `null` si esta versión de GNOME no lo admite. */
export const PixelateEffect = definePixelateEffect();
