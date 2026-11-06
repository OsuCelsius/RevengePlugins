// Steam Integration for Revenge / Kettu: badge under messages about a Steam
// game (owned / wishlisted / not owned, ignored, DLC, profile limited,
// trading cards, bundles, achievements). Long-press > "Steam info" for details.

import { ReactNative, url } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

import { appendNodes, link, patchMessageMenu, patchRows, rerender } from "../shared/mobile";
import { badgeText, BarterCache, clearResolved, details, extractSteam, getResolved, getUserData, resetUserData, resolve, setConfig, SteamTarget, targetKey } from "./logic";

const { FormSection, FormInput, FormRow, FormText } = Forms;

storage.cookie ??= "";

setConfig({
    cookie: () => storage.cookie,
    loadBarter: () => storage.barter as BarterCache | undefined,
    saveBarter: c => { storage.barter = c; }
});

const loading = new Set<string>();

function load(target: SteamTarget, msg: any) {
    const key = targetKey(target);
    if (loading.has(key)) return;
    loading.add(key);
    resolve(target).finally(() => {
        loading.delete(key);
        rerender(msg.channel_id, msg.id);
    });
}

async function showInfo(target: SteamTarget) {
    const info = getResolved(target) ?? await resolve(target);
    if (!info) return showToast("Steam: game not found", getAssetIDByName("WarningIcon"));
    const id = info.app.appId;
    ReactNative.Alert.alert("Steam", details(info), [
        { text: "Close", style: "cancel" },
        info.app.cards && { text: "Cards", onPress: () => url.openURL(`https://www.steamcardexchange.net/index.php?gamepage-appid-${id}`) },
        { text: "Store", onPress: () => url.openURL(`https://store.steampowered.com/app/${id}/`) }
    ].filter(Boolean) as any);
}

let unpatches: (() => void)[] = [];

export default {
    onLoad() {
        unpatches.push(patchRows((row, msg) => {
            const target = extractSteam(msg);
            if (!target) return;
            const info = getResolved(target);
            if (info === undefined) return load(target, msg);
            if (info) appendNodes(row, [link("🎮 " + badgeText(info), `https://store.steampowered.com/app/${info.app.appId}/`)]);
        }));

        unpatches.push(patchMessageMenu(msg => {
            const target = extractSteam(msg);
            return target ? [{ label: "Steam info", icon: getAssetIDByName("GameControllerIcon"), onPress: () => showInfo(target) }] : [];
        }));
    },

    onUnload() {
        unpatches.forEach(u => u());
        unpatches = [];
    },

    settings() {
        useProxy(storage);
        const check = async () => {
            resetUserData();
            clearResolved();
            const d = await getUserData();
            showToast(d ? `✔️ Logged in: ${d.owned.size} games owned` : "❌ Not logged in (cookie missing or expired)");
        };
        return (
            <FormSection title="Steam login (owned / wishlist / ignored)">
                <FormInput
                    title="steamLoginSecure cookie"
                    placeholder="7656119...%7C%7CeyJ..."
                    value={storage.cookie}
                    onChange={(v: string) => { storage.cookie = v; resetUserData(); clearResolved(); }}
                    secureTextEntry
                />
                <FormText style={{ marginHorizontal: 16, opacity: 0.7 }}>
                    Only stored on this phone. Copy it from store.steampowered.com in a desktop browser (DevTools {">"} Application {">"} Cookies {">"} steamLoginSecure). It expires after some months.
                </FormText>
                <FormRow label="Check login" leading={<FormRow.Icon source={getAssetIDByName("RefreshIcon")} />} onPress={check} />
            </FormSection>
        );
    }
};
