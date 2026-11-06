// Steam info logic, ported from the Vencord plugin. Ownership needs your
// steamLoginSecure cookie (pasted in the plugin settings, kept only on the phone)

import { collectText, http, httpJson, normTitle } from "../shared/text";

export interface SteamConfig {
    cookie(): string;
    loadBarter(): BarterCache | undefined;
    saveBarter(c: BarterCache): void;
}

let cfg: SteamConfig;
export const setConfig = (c: SteamConfig) => void (cfg = c);

const STEAM_TAG_RE = /\[Steam\]/i;
const STEAM_TITLE_RE = /\[Steam\]\s*(?:\([^)]*\))?\s*([^\n\]*]+)/i;
export const STEAM_APP_RE = /(?:store\.steampowered\.com\/(?:agecheck\/)?app|steamcommunity\.com\/app|steamdb\.info\/app)\/(\d+)/i;
const USERDATA_TTL = 5 * 60 * 1000;
const CARDS_CATEGORY = 29;

export interface SteamTarget { appId?: number; title?: string; }
export interface SteamApp { appId: number; name: string; type: string; cards: boolean; achievements: number; }
export interface SteamUserData { owned: Set<number>; wishlist: Set<number>; ignored: Set<number>; }

export function extractSteam(msg: any): SteamTarget | null {
    const texts = collectText(msg);
    for (const t of texts) {
        const m = t.match(STEAM_APP_RE);
        if (m) return { appId: Number(m[1]) };
    }
    if (!texts.some(t => STEAM_TAG_RE.test(t))) return null;
    const title = texts.map(t => t.match(STEAM_TITLE_RE)?.[1]?.trim()).find(Boolean);
    return title ? { title } : null;
}

export const targetKey = (t: SteamTarget) => t.appId ? `id:${t.appId}` : `t:${normTitle(t.title!)}`;

function steamCookie() {
    const c = (cfg.cookie() || "").trim();
    if (!c) return "";
    return c.includes("=") ? c : `steamLoginSecure=${c}`;
}

const steamJson = (url: string, withCookie = false) => {
    const headers: Record<string, string> = {};
    const c = withCookie ? steamCookie() : "";
    if (c) headers.Cookie = c;
    return httpJson(url, { headers, credentials: withCookie ? "omit" : "same-origin" });
};

async function findAppId(title: string) {
    const json = await steamJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&cc=US&l=english`);
    const items: any[] = (json?.items ?? []).filter((i: any) => i.type === "app");
    const want = normTitle(title);
    const hit = items.find(i => normTitle(i.name) === want)
        ?? items.find(i => { const n = normTitle(i.name); return n.length >= 4 && (want.includes(n) || n.includes(want)); });
    return hit ? Number(hit.id) : null;
}

async function fetchApp(appId: number): Promise<SteamApp | null> {
    const json = await steamJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic,categories,achievements`);
    const d = json?.[appId]?.data;
    if (!d) return null;
    return {
        appId,
        name: d.name,
        type: d.type,
        cards: (d.categories ?? []).some((c: any) => c.id === CARDS_CATEGORY),
        achievements: d.achievements?.total ?? 0
    };
}

let userData: { time: number; promise: Promise<SteamUserData | null>; } | null = null;
export const resetUserData = () => void (userData = null);

export function getUserData() {
    if (!steamCookie()) return Promise.resolve(null);
    if (userData && Date.now() - userData.time < USERDATA_TTL) return userData.promise;
    const promise = steamJson(`https://store.steampowered.com/dynamicstore/userdata/?t=${Date.now()}`, true).then(j => {
        if (!j) return null;
        // Logged out / expired cookie: Steam answers with everything empty
        if (!j.rgOwnedApps?.length && !j.rgWishlist?.length && !Object.keys(j.rgIgnoredApps ?? {}).length) return null;
        return {
            owned: new Set<number>(j.rgOwnedApps),
            wishlist: new Set<number>(j.rgWishlist),
            ignored: new Set<number>(Object.keys(j.rgIgnoredApps ?? {}).map(Number))
        };
    });
    userData = { time: Date.now(), promise };
    promise.then(d => { if (!d) userData = null; });
    return promise;
}

// ---------- Barter.vg ----------
const BARTER_TTL = 48 * 60 * 60 * 1000;

export interface BarterCache { time: number; bundles: Record<string, number> | null; limited: number[] | null; }
export interface BarterData { bundles: Record<string, number>; limited: Set<number>; }
let barter: Promise<BarterData | null> | null = null;

async function barterJson(path: string) {
    // barter.vg sometimes answers 500 on the big lists: one retry
    for (let i = 0; i < 2; i++) {
        const r = await http(`https://bartervg.com/browse/${path}/json/`, {}, 60000);
        if (r.status === 200) try { return JSON.parse(r.text) as Record<string, any>; } catch { }
        await new Promise(res => setTimeout(res, 3000));
    }
    return null;
}

export function getBarter() {
    return barter ??= (async () => {
        const cached = cfg.loadBarter();
        const toData = (c: BarterCache) => ({ bundles: c.bundles ?? {}, limited: new Set(c.limited ?? []) });
        if (cached?.bundles && cached.limited && Date.now() - cached.time < BARTER_TTL) return toData(cached);

        const [bundlesRaw, limitedRaw] = await Promise.all([barterJson("bundles"), barterJson("tag/481")]);
        let bundles: Record<string, number> | null = null;
        if (bundlesRaw) {
            bundles = {};
            for (const id in bundlesRaw) if (bundlesRaw[id]?.bundles > 0) bundles[id] = bundlesRaw[id].bundles;
        }
        const limited = limitedRaw ? Object.keys(limitedRaw).map(Number) : null;

        // A list that failed to download keeps its cached copy
        const merged: BarterCache = {
            time: bundles && limited ? Date.now() : cached?.time ?? 0,
            bundles: bundles ?? cached?.bundles ?? null,
            limited: limited ?? cached?.limited ?? null
        };
        if (!bundles || !limited) setTimeout(() => { barter = null; }, 10 * 60 * 1000);
        if (bundles || limited) cfg.saveBarter(merged);
        return merged.bundles || merged.limited ? toData(merged) : null;
    })();
}

const appCache = new Map<string, Promise<SteamApp | null>>();

export function getApp(target: SteamTarget) {
    const key = targetKey(target);
    let p = appCache.get(key);
    if (!p) {
        p = (async () => {
            const appId = target.appId ?? await findAppId(target.title!);
            return appId ? fetchApp(appId) : null;
        })().catch(() => null);
        p.then(a => { if (!a) appCache.delete(key); });
        appCache.set(key, p);
    }
    return p;
}

// ---------- badge text ----------
export interface SteamInfo { app: SteamApp; user: SteamUserData | null; barter: BarterData | null; }

const resolved = new Map<string, SteamInfo | null>();
export const getResolved = (t: SteamTarget) => resolved.get(targetKey(t));
export const clearResolved = () => resolved.clear();

export async function resolve(target: SteamTarget) {
    const [app, user, b] = await Promise.all([getApp(target), getUserData().catch(() => null), getBarter().catch(() => null)]);
    const info = app ? { app, user, barter: b } : null;
    resolved.set(targetKey(target), info);
    return info;
}

// One-line badge, same icons as the desktop version
export function badgeText({ app, user, barter }: SteamInfo) {
    const id = app.appId;
    const parts: string[] = [];
    if (!user) parts.push("❔");
    else if (user.owned.has(id)) parts.push("✅ Owned");
    else if (user.wishlist.has(id)) parts.push("💗 Wishlist");
    else parts.push("❌ Not owned");
    if (user?.ignored.has(id)) parts.push("🚫");
    if (app.type === "dlc") parts.push("DLC");
    if (barter?.limited.has(id)) parts.push("⚙️ Limited");
    if (app.cards) parts.push("🃏");
    if (barter?.bundles[id]) parts.push(`🎁${barter.bundles[id]}`);
    if (app.achievements > 0) parts.push(`🏆${app.achievements}`);
    return parts.join(" · ");
}

export function details({ app, user, barter }: SteamInfo) {
    const id = app.appId;
    const kind = app.type === "dlc" ? "DLC" : "Game";
    const lines = [`${app.name} (${kind} ${id})`];
    if (!user) lines.push("Ownership unknown: paste your steamLoginSecure cookie in the plugin settings");
    else if (user.owned.has(id)) lines.push("Owned");
    else if (user.wishlist.has(id)) lines.push("Wishlisted");
    else lines.push("Not owned");
    if (user?.ignored.has(id)) lines.push("Ignored");
    if (barter?.limited.has(id)) lines.push("Profile features limited");
    if (app.cards) lines.push("Has trading cards");
    if (barter?.bundles[id]) lines.push(`Bundled ${barter.bundles[id]} time${barter.bundles[id] === 1 ? "" : "s"}`);
    if (app.achievements > 0) lines.push(`${app.achievements} achievements`);
    return lines.join("\n");
}
