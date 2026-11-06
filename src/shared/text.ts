// Helpers shared by the plugins: message text walking, fetch with timeout and
// a tiny regex HTML toolkit (React Native has no DOMParser)

export function deepStrings(value: any, out: string[], depth: number, seen: WeakSet<object>) {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
        if (value.length < 4000) out.push(value);
        return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const v of value) deepStrings(v, out, depth + 1, seen);
        return;
    }
    for (const k in value) {
        try { deepStrings(value[k], out, depth + 1, seen); } catch { }
    }
}

// Raw text of a message: content, embeds, components V2 and forwarded snapshots
export function collectText(msg: any): string[] {
    const out: string[] = [];
    const seen = new WeakSet<object>();
    const fromMsg = (m: any) => {
        if (!m) return;
        if (typeof m.content === "string" && m.content) out.push(m.content);
        deepStrings(m.embeds, out, 0, seen);
        deepStrings(m.components, out, 0, seen);
    };
    fromMsg(msg);
    for (const s of msg?.messageSnapshots ?? msg?.message_snapshots ?? []) fromMsg(s?.message);
    return out;
}

export const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface HttpResult { status: number; text: string; url: string; }

export async function http(url: string, init: RequestInit = {}, timeout = 15000): Promise<HttpResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        return { status: res.status, text: await res.text(), url: res.url || url };
    } catch (e) {
        return { status: 0, text: String(e), url };
    } finally {
        clearTimeout(t);
    }
}

export async function httpJson(url: string, init?: RequestInit, timeout?: number) {
    const r = await http(url, init, timeout);
    if (r.status !== 200) return null;
    try { return JSON.parse(r.text); } catch { return null; }
}

// ---------- HTML ----------
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
});

export const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

export function attr(tag: string, name: string) {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

export const hasClass = (tag: string, cls: string) => (attr(tag, "class") ?? "").split(/\s+/).includes(cls);

// Opening tags of an element type, optionally with a class
export function tags(html: string, tag: string, cls?: string) {
    const out: string[] = [];
    for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi")))
        if (!cls || hasClass(m[0], cls)) out.push(m[0]);
    return out;
}

// Opening tag + inner HTML of elements (no nesting of the same tag inside)
export function elements(html: string, tag: string, cls?: string) {
    const out: { tag: string; inner: string; }[] = [];
    for (const m of html.matchAll(new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)</${tag}>`, "gi")))
        if (!cls || hasClass(m[1], cls)) out.push({ tag: m[1], inner: m[2] });
    return out;
}

export function itemprop(html: string, prop: string) {
    const out: string[] = [];
    for (const m of html.matchAll(/<(\w+)\b([^>]*)>([^<]*)</g))
        if (attr(" " + m[2], "itemprop") === prop) out.push(stripTags(m[3]));
    return out;
}
