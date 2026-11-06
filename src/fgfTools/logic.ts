// FGFTools logic, ported from the Vencord plugin. Everything runs in the
// plugin itself: React Native's fetch has no CORS, so itch.io / reddit /
// egdata are called directly (the desktop version needed native.ts for that).

import { attr, collectText, deepStrings, elements, hasClass, http, HttpResult, itemprop, normTitle, sleep, stripTags, tags } from "../shared/text";

export interface FGFConfig {
    cookie(): string;
    maxConcurrentClaims(): number;
    maxConcurrentFetches(): number;
    claimed: Set<string>;
    saveClaimed(): void;
}

let cfg: FGFConfig;
export const setConfig = (c: FGFConfig) => void (cfg = c);

// ---------- constants ----------
const CACHE_TTL = 5 * 60 * 60 * 1000;
const FETCH_ATTEMPTS = 3;
const CLAIM_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF = 3000;

const URL_RE = /https?:\/\/(?:[a-z0-9-]+\.itch\.io\/[a-z0-9_-]+|itch\.io\/[sb]\/[^\s)>\]"'<]+)/gi;
const SALE_RE = /^https:\/\/itch\.io\/[sb]\//;
const GAME_RE = /^https:\/\/[a-z0-9-]+\.itch\.io\/[a-z0-9_-]+$/i;
const ITCH_URL = /^https:\/\/([a-z0-9-]+\.)?itch\.io\//i;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// ---------- types ----------
type Status = "owned" | "claimable" | "free" | "paid" | "unknown";

export interface GameInfo {
    url: string;
    status: Status;
    title?: string;
    price?: string;
    isSale?: boolean;
    gameUrls?: string[];
    time?: number;
}

const store = new Map<string, GameInfo>();

// ---------- concurrency ----------
function makeLimiter(getMax: () => number) {
    let active = 0;
    const queue: (() => void)[] = [];
    const next = () => {
        while (active < Math.max(1, getMax() || 1) && queue.length) {
            active++;
            queue.shift()!();
        }
    };
    return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
        queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
        next();
    });
}

const fetchLimited = makeLimiter(() => cfg.maxConcurrentFetches());
const claimLimited = makeLimiter(() => cfg.maxConcurrentClaims());

// ---------- requests ----------
export function cookie() {
    const c = (cfg.cookie() || "").trim();
    if (!c) return "";
    return c.includes("=") ? c : `itchio=${c}`;
}

function itchRequest(url: string, method: "GET" | "POST", body: string | null): Promise<HttpResult> {
    if (!ITCH_URL.test(url)) return Promise.resolve({ status: 0, text: "", url });
    const headers: Record<string, string> = { "User-Agent": UA, "Cache-Control": "no-cache", "Pragma": "no-cache" };
    const c = cookie();
    if (c) headers.Cookie = c;
    if (body !== null) headers["Content-Type"] = "application/x-www-form-urlencoded";
    return http(url, { method, headers, body: body ?? undefined, credentials: "omit" });
}

const get = (url: string) => itchRequest(url, "GET", null);
const post = (url: string, token: string) => itchRequest(url, "POST", "csrf_token=" + encodeURIComponent(token));

// ---------- page parsing ----------
function isOwned(html: string) {
    if (/class="[^"]*\bownership_reason\b/.test(html)) return true;
    const banner = elements(html, "div", "purchase_banner_inner")[0];
    return !!banner && /You (own|claimed)\b|already (own|claimed)/i.test(stripTags(banner.inner));
}

const buttonTexts = (html: string, cls: string) =>
    [...elements(html, "a"), ...elements(html, "button")].filter(e => hasClass(e.tag, cls)).map(e => stripTags(e.inner));

function parseGame(url: string, html: string): GameInfo {
    const titleEl = elements(html, "h1", "game_title")[0];
    const title = titleEl ? stripTags(titleEl.inner) || undefined : undefined;
    if (isOwned(html) || cfg.claimed.has(url)) return { url, status: "owned", title };

    const prices = itemprop(html, "price");
    const price = prices[0] || undefined;
    if (buttonTexts(html, "buy_btn").some(t => /Download or claim|Claim/i.test(t))) return { url, status: "claimable", title, price };

    const hasPurchase = prices.some(p => p !== "$0.00 USD");
    const hasFreeDl = [...buttonTexts(html, "download_btn"), ...buttonTexts(html, "buy_btn")].some(t => /Download/i.test(t));
    if (hasFreeDl && !hasPurchase) return { url, status: "free", title };
    if (price) return { url, status: "paid", title, price };
    return { url, status: "unknown", title };
}

async function fetchGame(url: string): Promise<GameInfo | null> {
    const r = await fetchLimited(() => get(url));
    if (r.status !== 200) return null;

    if (SALE_RE.test(url)) {
        const links = [...new Set(
            tags(r.text, "a")
                .map(a => (attr(a, "href") || "").split("?")[0])
                .filter(h => GAME_RE.test(h))
        )];
        if (links.length) {
            const games = await Promise.all(links.map(getGame));
            const gameUrls = games.filter(g => g?.status === "claimable").map(g => g!.url);
            const h1 = elements(r.text, "h1")[0];
            const title = (h1 && stripTags(h1.inner)) || "Sale / Bundle";
            if (games.every(g => g?.status === "owned")) return { url, status: "owned", title, isSale: true };
            if (gameUrls.length) return { url, status: "claimable", title, isSale: true, gameUrls };
            if (games.some(g => g === null)) return null;
            return { url, status: "paid", title, isSale: true, price: "Bundle" };
        }
    }
    return parseGame(url, r.text);
}

const inflight = new Map<string, Promise<GameInfo | null>>();

export function getGame(url: string): Promise<GameInfo | null> {
    const cached = store.get(url);
    if (cached && Date.now() - (cached.time || 0) < CACHE_TTL) return Promise.resolve(cached);
    if (inflight.has(url)) return inflight.get(url)!;

    const p = (async () => {
        try {
            for (let i = 0; i < FETCH_ATTEMPTS; i++) {
                try {
                    const g = await fetchGame(url);
                    if (g) {
                        store.set(url, { ...g, time: Date.now() });
                        return g;
                    }
                } catch { }
                await sleep(1500 * (i + 1));
            }
            return null;
        } finally {
            inflight.delete(url);
        }
    })();
    inflight.set(url, p);
    return p;
}

// ---------- claiming ----------
let csrfToken: string | null = null;

function csrfFrom(html: string) {
    const input = tags(html, "input").find(t => attr(t, "name") === "csrf_token");
    const meta = tags(html, "meta").find(t => attr(t, "name") === "csrf_token");
    return (input && attr(input, "value")) || (meta && (attr(meta, "value") || attr(meta, "content"))) || null;
}

async function getCsrf(gameUrl: string, force: boolean) {
    if (csrfToken && !force) return csrfToken;
    const r = await get(gameUrl + "/purchase");
    const v = csrfFrom(r.text);
    if (v) csrfToken = v;
    return v;
}

async function claimOnce(url: string, refresh: boolean): Promise<{ ok: boolean; backoff?: boolean; refresh?: boolean; }> {
    const token = await getCsrf(url, refresh);
    if (!token) return { ok: false, refresh: true };

    const dl = await post(url + "/download_url", token);
    if (dl.status === 429) return { ok: false, backoff: true };
    let data: any;
    try { data = JSON.parse(dl.text); } catch { return { ok: false, backoff: true, refresh: true }; }
    if (!data?.url) return { ok: false, refresh: true };

    const page = await get(data.url);
    if (page.status === 429) return { ok: false, backoff: true };
    // <div class="claim_to_download_box"> ... <form action="..."> <input name="csrf_token">
    const boxAt = page.text.search(/class="[^"]*\bclaim_to_download_box\b/);
    if (boxAt < 0) return { ok: true }; // nothing to claim = already yours
    const form = elements(page.text.slice(boxAt), "form")[0];
    const formToken = form && csrfFrom(form.inner);
    if (!form || !formToken) return { ok: true };

    const action = attr(form.tag, "action") || "";
    const res = await post(action, formToken);
    if (res.status === 429) return { ok: false, backoff: true };
    return { ok: /You claimed this|already claimed/i.test(res.text) };
}

function claimGame(url: string) {
    return claimLimited(async () => {
        let refresh = false;
        for (let i = 0; i < CLAIM_ATTEMPTS; i++) {
            try {
                const r = await claimOnce(url, refresh);
                if (r.ok) return true;
                refresh = !!r.refresh;
                if (r.backoff) await sleep(RATE_LIMIT_BACKOFF * (i + 1));
            } catch {
                await sleep(1000 * (i + 1));
            }
        }
        return false;
    });
}

function markClaimed(url: string) {
    cfg.claimed.add(url);
    const g = store.get(url);
    if (g) store.set(url, { ...g, status: "owned" });
    cfg.saveClaimed();
}

// Checks every link, then claims what can be claimed. onProgress gets a
// short status text for the toast
export async function claimAll(urls: string[], onProgress: (text: string) => void) {
    onProgress("⌛ Checking...");
    const infos = await Promise.all(urls.map(getGame));

    const gameUrls = new Set<string>();
    for (const g of infos) {
        if (!g || g.status !== "claimable") continue;
        if (g.isSale && g.gameUrls) g.gameUrls.forEach(u => gameUrls.add(u));
        else gameUrls.add(g.url);
    }
    const total = gameUrls.size;
    if (!total) return infos.some(g => !g) ? "⚠️ Some itch.io pages failed to load" : "✔️ Nothing to claim";

    let done = 0, ok = 0;
    onProgress(`⌛ Claiming 0/${total}`);
    await Promise.all([...gameUrls].map(async u => {
        if (await claimGame(u)) { ok++; markClaimed(u); }
        done++;
        onProgress(`⌛ Claiming ${done}/${total}`);
    }));
    return ok === total ? `✔️ Claimed ${ok}` : `⚠️ Claimed ${ok}/${total}`;
}

// ---------- link extraction ----------
export function extractUrls(msg: any): string[] {
    const urls = new Set<string>();
    for (const t of collectText(msg)) {
        for (const m of t.matchAll(URL_RE)) {
            let u = m[0].replace(/^http:/i, "https:").split("?")[0].replace(/[.,;:!*_~]+$/, "");
            u = u.replace(/^https:\/\/([^/]+)/, (_, h) => "https://" + h.toLowerCase());
            if (/^https:\/\/www\.itch\.io/.test(u)) continue;
            if (GAME_RE.test(u) || SALE_RE.test(u)) urls.add(u);
        }
    }
    return [...urls];
}

// ---------- Epic Games instant checkout ----------
const EPIC_TAG_RE = /\[Epic Games( Mobile)?\]/i;
const REDDIT_POST_RE = /reddit\.com\/r\/\w+\/comments\/([a-z0-9]+)/i;
const EPIC_TITLE_RE = /\[Epic Games(?: Mobile)?\]\s*(?:\([^)]*\))?\s*([^\n\]*]+)/i;
const CHECKOUT_RE = /https:\/\/store\.epicgames\.com\/(?:[a-z-]+\/)?purchase\?[\w\-&=%.]*offers=[\w\-&=%.]+/i;
const EPIC_PROMOS = "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US";
const EPIC_RETRY = 10 * 60 * 1000;

export interface EpicInfo { postId?: string; title?: string; direct?: string; mobile?: boolean; }

export function extractEpic(msg: any): EpicInfo | null {
    const texts = collectText(msg);
    const tag = texts.map(t => t.match(EPIC_TAG_RE)).find(Boolean);
    if (!tag) return null;
    const mobile = !!tag[1];
    let postId: string | undefined, title: string | undefined, direct: string | undefined;
    for (const t of texts) {
        direct ??= t.match(CHECKOUT_RE)?.[0];
        postId ??= t.match(REDDIT_POST_RE)?.[1];
        title ??= t.match(EPIC_TITLE_RE)?.[1]?.trim() || undefined;
    }
    return postId || title || direct ? { postId, title, direct, mobile } : null;
}

async function checkoutFromReddit(postId: string) {
    if (!/^[a-z0-9]+$/i.test(postId)) return null;
    const r = await http(`https://www.reddit.com/comments/${postId}.json?raw_json=1`, {
        headers: { "User-Agent": "android:revenge-fgftools:1.0 (Discord client plugin)" }
    });
    if (r.status !== 200) return null;
    const strings: string[] = [];
    try { deepStrings(JSON.parse(r.text), strings, -12, new WeakSet()); } catch { return null; }
    for (const s of strings) {
        const m = s.match(CHECKOUT_RE);
        if (m) return m[0];
    }
    return null;
}

type Platform = "pc" | "android" | "ios";

function offerPlatform(e: any): Platform {
    const attrs = e.customAttributes || {};
    const tagNames = (e.tags || []).map((t: any) => t?.name);
    if ("androidCatalogItemId" in attrs || tagNames.includes("Android")) return "android";
    if ("iosCatalogItemId" in attrs || tagNames.includes("iOS")) return "ios";
    return "pc";
}

async function checkoutFromEgdata(title: string, mobile = false) {
    const want = normTitle(title);
    const queries = [title, ...title.split(/\s+[-–—:|]\s+|:\s+/).map(s => s.trim()).filter(s => normTitle(s).length >= 3)];
    const platforms: Platform[] = mobile ? ["android", "ios"] : ["pc"];
    const best = new Map<Platform, { e: any; score: number; }>();

    for (const q of [...new Set(queries)]) {
        const r = await http(`https://api.egdata.app/autocomplete?query=${encodeURIComponent(q)}`, {
            headers: { "User-Agent": UA, "Accept": "application/json" }
        });
        if (r.status !== 200) continue;
        let els: any[];
        try { els = JSON.parse(r.text)?.elements ?? []; } catch { continue; }
        for (const e of els) {
            if (!e.id || !e.namespace || e.offerType === "OTHERS" || /\bdemo\b/i.test(e.title || "")) continue;
            const got = normTitle(e.title || "");
            if (got.length < 4) continue;
            const match = got === want ? 4 : want.includes(got) || got.includes(want) ? 2 : 0;
            if (!match) continue;
            const platform = offerPlatform(e);
            if (!platforms.includes(platform)) continue;
            const score = match + (e.offerType === "BASE_GAME" ? 1 : 0);
            const cur = best.get(platform);
            if (!cur || score > cur.score) best.set(platform, { e, score });
        }
        if (platforms.every(p => (best.get(p)?.score ?? 0) >= 4)) break;
    }

    const offers = platforms.map(p => best.get(p)?.e).filter(Boolean).map(e => `offers=1-${e.namespace}-${e.id}`);
    if (!offers.length) return null;
    return `https://store.epicgames.com/purchase?${offers.join("&")}` + (mobile ? "#/free-checkout" : "");
}

async function checkoutFromPromotions(title: string) {
    const r = await http(EPIC_PROMOS);
    if (r.status !== 200) return null;
    let els: any[];
    try { els = JSON.parse(r.text)?.data?.Catalog?.searchStore?.elements ?? []; } catch { return null; }
    const want = normTitle(title);
    const e = els.find(e => normTitle(e.title || "") === want && e.promotions?.promotionalOffers?.length);
    return e ? `https://store.epicgames.com/purchase?offers=1-${e.namespace}-${e.id}` : null;
}

const checkoutCache = new Map<string, { time: number; promise: Promise<string | null>; }>();

export function getCheckout(epic: EpicInfo): Promise<string | null> {
    if (epic.direct) return Promise.resolve(epic.direct);
    const key = epic.postId || epic.title!;
    const cached = checkoutCache.get(key);
    if (cached && Date.now() - cached.time < EPIC_RETRY) return cached.promise;

    // Each source is tried on its own: one failing must not skip the others
    const sources: (() => Promise<string | null>)[] = [];
    if (epic.postId) sources.push(() => checkoutFromReddit(epic.postId!));
    if (epic.title) sources.push(() => checkoutFromEgdata(epic.title!, epic.mobile));
    // Weekly promotions list only has PC offers
    if (epic.title && !epic.mobile) sources.push(() => checkoutFromPromotions(epic.title!));

    const promise = (async () => {
        for (const fn of sources) {
            try {
                const link = await fn();
                if (link) return link;
            } catch { }
        }
        return null;
    })();
    // Keep hits forever, retry misses after EPIC_RETRY
    promise.then(link => { if (link) checkoutCache.set(key, { time: Infinity, promise }); });
    checkoutCache.set(key, { time: Date.now(), promise });
    return promise;
}

// ---------- GOG giveaways ----------
const GOG_TAG_RE = /\[GOG\]/i;
export const GOG_CLAIM_URL = "https://www.gog.com/giveaway/claim";
export const isGog = (msg: any) => collectText(msg).some(t => GOG_TAG_RE.test(t));
