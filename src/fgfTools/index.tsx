// FGFTools for Revenge / Kettu: itch.io Claim All, Epic and GOG CLAIM.
// - Epic / GOG: a "🛄 CLAIM" link is added under the giveaway message.
// - itch.io: long-press the message > "Claim All (itch.io)".

import { url } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

import { appendNodes, link, MenuItem, patchMessageMenu, patchRows, rerender } from "../shared/mobile";
import { claimAll, cookie, EpicInfo, extractEpic, extractUrls, getCheckout, GOG_CLAIM_URL, isGog, setConfig } from "./logic";

const { FormSection, FormInput, FormDivider, FormText } = Forms;

storage.cookie ??= "";
storage.maxConcurrentClaims ??= 4;
storage.maxConcurrentFetches ??= 3;
storage.claimed ??= [];

const claimed = new Set<string>(storage.claimed);
setConfig({
    cookie: () => storage.cookie,
    maxConcurrentClaims: () => Number(storage.maxConcurrentClaims) || 4,
    maxConcurrentFetches: () => Number(storage.maxConcurrentFetches) || 3,
    claimed,
    saveClaimed: () => { storage.claimed = [...claimed]; }
});

// ---------- Epic checkout links ----------
const epicKey = (e: EpicInfo) => e.direct || e.postId || e.title || "";
const checkouts = new Map<string, string | null>();
const pending = new Set<string>();

function loadCheckout(epic: EpicInfo, msg: any) {
    const key = epicKey(epic);
    if (pending.has(key)) return;
    pending.add(key);
    getCheckout(epic).then(l => {
        pending.delete(key);
        checkouts.set(key, l);
        rerender(msg.channel_id, msg.id);
    });
}

function openCheckout(epic: EpicInfo) {
    showToast("⌛ Finding checkout...", getAssetIDByName("ClockIcon"));
    getCheckout(epic).then(l => {
        if (l) url.openURL(l);
        else showToast("⚠️ No checkout link found", getAssetIDByName("WarningIcon"));
    });
}

// ---------- itch.io ----------
let claiming = false;

async function runClaimAll(urls: string[]) {
    if (claiming) return showToast("⌛ Already claiming...");
    if (!cookie()) return showToast("⚙️ FGFTools: set your itch.io cookie in the plugin settings");
    claiming = true;
    try {
        let last = "";
        const result = await claimAll(urls, t => {
            // One toast per change is enough; skip repeats
            if (t !== last) showToast(last = t);
        });
        showToast(result, getAssetIDByName(result.startsWith("✔") ? "CheckmarkLargeIcon" : "WarningIcon"));
    } catch (e) {
        showToast("⚠️ Claim failed: " + String(e));
    } finally {
        claiming = false;
    }
}

let unpatches: (() => void)[] = [];

export default {
    onLoad() {
        unpatches.push(patchRows((row, msg) => {
            const epic = extractEpic(msg);
            if (epic) {
                const key = epicKey(epic);
                if (epic.direct) appendNodes(row, [link("🛄 CLAIM", epic.direct)]);
                else if (checkouts.has(key)) {
                    const l = checkouts.get(key);
                    if (l) appendNodes(row, [link("🛄 CLAIM", l)]);
                } else loadCheckout(epic, msg);
            }
            if (isGog(msg)) appendNodes(row, [link("🛄 CLAIM", GOG_CLAIM_URL)]);
        }));

        unpatches.push(patchMessageMenu(msg => {
            const items: MenuItem[] = [];
            const urls = extractUrls(msg);
            if (urls.length) items.push({ label: "Claim All (itch.io)", icon: getAssetIDByName("DownloadIcon"), onPress: () => runClaimAll(urls) });
            const epic = extractEpic(msg);
            if (epic) items.push({ label: "CLAIM (Epic Games)", icon: getAssetIDByName("GiftIcon"), onPress: () => openCheckout(epic) });
            if (isGog(msg)) items.push({ label: "CLAIM (GOG)", icon: getAssetIDByName("GiftIcon"), onPress: () => url.openURL(GOG_CLAIM_URL) });
            return items;
        }));
    },

    onUnload() {
        unpatches.forEach(u => u());
        unpatches = [];
    },

    settings() {
        useProxy(storage);
        return (
            <>
                <FormSection title="itch.io">
                    <FormInput
                        title="Session cookie"
                        placeholder="value of the 'itchio' cookie"
                        value={storage.cookie}
                        onChange={(v: string) => { storage.cookie = v; }}
                        secureTextEntry
                    />
                    <FormText style={{ marginHorizontal: 16, opacity: 0.7 }}>
                        Only stored on this phone. Get it from itch.io in a desktop browser (DevTools {">"} Application {">"} Cookies {">"} itchio).
                    </FormText>
                    <FormDivider />
                    <FormInput
                        title="Games claimed at the same time"
                        keyboardType="numeric"
                        value={String(storage.maxConcurrentClaims)}
                        onChange={(v: string) => { storage.maxConcurrentClaims = Number(v) || 1; }}
                    />
                    <FormInput
                        title="itch.io pages checked at the same time"
                        keyboardType="numeric"
                        value={String(storage.maxConcurrentFetches)}
                        onChange={(v: string) => { storage.maxConcurrentFetches = Number(v) || 1; }}
                    />
                </FormSection>
            </>
        );
    }
};
