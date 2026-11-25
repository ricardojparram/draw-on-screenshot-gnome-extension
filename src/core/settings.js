import Clutter from 'gi://Clutter';
import { logWarning } from './log.js';

/**
 * Puente entre GSettings y el resto de la extensión.
 *
 * Concentra aquí dos cosas que no conviene repetir: la conversión de `#rrggbb`
 * a los componentes 0..1 que consume Cairo, y el análisis de las cadenas de
 * acelerador estilo GTK que guardan las preferencias.
 */

/** Convierte `#rrggbb` (o `#rgb`) en `{ hex, r, g, b, a }`, o `null` si no es válido. */
export function parseHexColor(hex) {
    if (typeof hex !== 'string') return null;

    let body = hex.trim().replace(/^#/, '');
    if (body.length === 3) {
        body = body.split('').map(c => c + c).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(body)) return null;

    const value = parseInt(body, 16);
    return {
        hex: `#${body.toLowerCase()}`,
        r: ((value >> 16) & 0xff) / 255,
        g: ((value >> 8) & 0xff) / 255,
        b: (value & 0xff) / 255,
        a: 1.0,
    };
}

/** Luminancia relativa aproximada; sirve para elegir texto blanco o negro encima. */
export function luminance(color) {
    return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/**
 * Teclas que, en la práctica, el usuario espera que se comporten igual.
 * Cada grupo se resuelve a un único símbolo canónico antes de comparar, de modo
 * que un atajo guardado como `plus` también responda al `=` de la fila numérica
 * o al `+` del teclado numérico.
 */
const KEY_ALIASES = [
    [Clutter.KEY_plus, Clutter.KEY_equal, Clutter.KEY_KP_Add],
    [Clutter.KEY_minus, Clutter.KEY_underscore, Clutter.KEY_KP_Subtract],
    [Clutter.KEY_Delete, Clutter.KEY_KP_Delete, Clutter.KEY_BackSpace],
];

function canonicalKey(symbol) {
    // Las letras se comparan sin distinguir mayúsculas: `p` y `P` son el mismo
    // atajo, y Shift ya se compara por separado en el campo de modificadores.
    if (symbol >= Clutter.KEY_A && symbol <= Clutter.KEY_Z) {
        return symbol + (Clutter.KEY_a - Clutter.KEY_A);
    }
    for (const group of KEY_ALIASES) {
        if (group.includes(symbol)) return group[0];
    }
    return symbol;
}

/**
 * Códigos de tecla del hardware de la zona alfanumérica, tal y como los reporta
 * Clutter (keycode de X11, es decir evdev + 8; mutter usa la misma numeración en
 * Wayland). Cada fila arranca en un código y avanza de uno en uno.
 *
 * Sirven para que los atajos sigan funcionando con distribuciones NO latinas
 * (cirílico, griego, hebreo, árabe, kana…): ahí la tecla física «p» no produce
 * el símbolo `p`, sino su equivalente en el alfabeto local, y comparar sólo por
 * símbolo dejaba todos los atajos muertos. Esa es la razón de que «los atajos no
 * sirvan en algunas máquinas»: no depende del equipo, sino de la distribución de
 * teclado activa.
 */
const KEYCODE_ROWS = [
    [10, '1234567890-='],
    [24, 'qwertyuiop[]'],
    [38, "asdfghjkl;'"],
    [52, 'zxcvbnm,./'],
];

/** Símbolo latino -> código de tecla física en la distribución de referencia. */
const KEYCODE_BY_SYMBOL = new Map();
for (const [first, chars] of KEYCODE_ROWS) {
    for (let i = 0; i < chars.length; i++) {
        // Store under canonicalKey so aliased keys like `plus` (`=`) also get a hardware keycode.
        KEYCODE_BY_SYMBOL.set(canonicalKey(chars.charCodeAt(i)), first + i);
    }
}

/**
 * ¿Es un símbolo del bloque ASCII imprimible? Si lo es, la distribución activa
 * es latina y hay que fiarse de ella: el respaldo por código de tecla haría que,
 * por ejemplo, en AZERTY la tecla rotulada «Q» disparase el atajo `a`.
 */
function isLatinSymbol(symbol) {
    return symbol >= 0x20 && symbol <= 0x7e;
}

const MODIFIER_TOKENS = {
    control: Clutter.ModifierType.CONTROL_MASK,
    primary: Clutter.ModifierType.CONTROL_MASK,
    ctrl: Clutter.ModifierType.CONTROL_MASK,
    shift: Clutter.ModifierType.SHIFT_MASK,
    alt: Clutter.ModifierType.MOD1_MASK,
    mod1: Clutter.ModifierType.MOD1_MASK,
    super: Clutter.ModifierType.SUPER_MASK,
    mod4: Clutter.ModifierType.SUPER_MASK,
    meta: Clutter.ModifierType.SUPER_MASK,
};

/** Sólo estos modificadores participan en la comparación de atajos. */
export const RELEVANT_MODIFIERS =
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK;

/**
 * Analiza una cadena de acelerador de GTK (`<Control><Shift>z`, `Delete`, `p`).
 *
 * No se usa `Gtk.accelerator_parse` porque las reglas de extensions.gnome.org
 * prohíben importar Gtk dentro del proceso de GNOME Shell.
 *
 * @returns {{ symbol: number, mods: number, keycode: number }|null}
 *   `keycode` es 0 cuando la tecla no está en la zona alfanumérica y, por tanto,
 *   no necesita el respaldo por posición física.
 */
export function parseAccelerator(accel) {
    if (typeof accel !== 'string') return null;

    const text = accel.trim();
    if (text.length === 0) return null;

    let mods = 0;
    let rest = text;

    const modRe = /^<([^>]+)>/;
    let match;
    while ((match = modRe.exec(rest)) !== null) {
        const token = match[1].toLowerCase();
        const mask = MODIFIER_TOKENS[token];
        if (mask === undefined) {
            logWarning(`Modificador desconocido en el atajo «${accel}»`);
            return null;
        }
        mods |= mask;
        rest = rest.slice(match[0].length);
    }

    if (rest.length === 0) return null;

    // Los nombres de tecla de GTK y las constantes `Clutter.KEY_*` provienen
    // ambos de la tabla de keysyms de X, así que la correspondencia es directa.
    const symbol = Clutter[`KEY_${rest}`];
    if (typeof symbol !== 'number') {
        logWarning(`Tecla desconocida en el atajo «${accel}»`);
        return null;
    }

    const canonical = canonicalKey(symbol);
    return {
        symbol: canonical,
        mods,
        keycode: KEYCODE_BY_SYMBOL.get(canonical) ?? 0,
    };
}

/**
 * ¿Coincide el evento de teclado con el atajo analizado?
 *
 * @param {number} keycode Código de tecla física del evento
 *   (`Clutter.Event.get_key_code()`). Opcional: sin él sólo se compara el
 *   símbolo, que es lo correcto con distribuciones latinas.
 */
export function acceleratorMatches(binding, symbol, state, keycode = 0) {
    if (!binding) return false;

    let normalizedState = state;
    if ((normalizedState & Clutter.ModifierType.MOD4_MASK) !== 0) {
        normalizedState |= Clutter.ModifierType.SUPER_MASK;
    }
    const active = normalizedState & RELEVANT_MODIFIERS;
    let modsOk = active === binding.mods;

    // Un atajo sin modificadores debe seguir respondiendo con Bloq Mayús puesto
    // o con Mayús pulsada: `P` y `p` son la misma tecla para el usuario.
    if (!modsOk && binding.mods === 0) {
        modsOk = (active & ~Clutter.ModifierType.SHIFT_MASK) === 0;
    }
    if (!modsOk) return false;

    if (canonicalKey(symbol) === binding.symbol) return true;

    // Distribución no latina: el símbolo nunca podrá coincidir, así que se
    // compara la POSICIÓN de la tecla. Con una distribución latina no se llega
    // aquí, de modo que AZERTY o Dvorak siguen mandando sobre la posición.
    return binding.keycode !== 0 &&
           keycode === binding.keycode &&
           !isLatinSymbol(symbol);
}

/** Nombres de tecla que se leen mejor con su símbolo o su forma abreviada. */
const KEY_LABELS = {
    plus: '+',
    equal: '=',
    minus: '−',
    underscore: '_',
    KP_Add: 'Num +',
    KP_Subtract: 'Num −',
    Delete: 'Del',
    BackSpace: '⌫',
    Return: '↵',
    space: '␣',
    Escape: 'Esc',
};

/**
 * Versión legible de un acelerador, para rótulos y tooltips: `<Control>z` se
 * convierte en `Ctrl+Z`. Devuelve cadena vacía si el atajo está desactivado.
 */
export function describeAccelerator(accel) {
    if (typeof accel !== 'string' || accel.trim().length === 0) return '';

    const parts = [];
    let rest = accel.trim();

    const modRe = /^<([^>]+)>/;
    let match;
    while ((match = modRe.exec(rest)) !== null) {
        const token = match[1].toLowerCase();
        if (token === 'control' || token === 'primary' || token === 'ctrl') parts.push('Ctrl');
        else if (token === 'shift') parts.push('Shift');
        else if (token === 'alt') parts.push('Alt');
        else if (token === 'super') parts.push('Super');
        rest = rest.slice(match[0].length);
    }

    if (rest.length === 0) return '';

    parts.push(KEY_LABELS[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest));
    return parts.join('+');
}
