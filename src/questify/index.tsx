// Questify for Revenge / Kettu: toast when Discord publishes a new quest or you
// complete one, periodic quest checks, and a list of unclaimed quests in the
// plugin settings (tap one to open it). No dummy exe launcher on mobile.

import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, url } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormSwitchRow, FormInput, FormRow, FormText } = Forms;

interface Quest {
    id: string;
    config: {
        expiresAt: string;
        messages: { questName: string; gameTitle?: string; };
        rewardsConfig?: { rewards?: { messages?: { name?: string; }; }[]; };
    };
    userStatus?: { completedAt?: string | null; claimedAt?: string | null; } | null;
}

const QuestStore = findByStoreName("QuestStore");
const QuestActions = findByProps("fetchCurrentQuests");

storage.notifyNewQuests ??= true;
storage.notifyCompleted ??= true;
storage.checkInterval ??= 30;

const isActive = (q: Quest) => new Date(q.config.expiresAt).getTime() > Date.now();
const isPending = (q: Quest) => isActive(q) && q.userStatus?.claimedAt == null;
const reward = (q: Quest) => q.config.rewardsConfig?.rewards?.[0]?.messages?.name;
const openQuest = (q?: Quest) => url.openURL(q ? `https://discord.com/quests/${q.id}` : "https://discord.com/quest-home");

function allQuests(): Quest[] {
    const quests = QuestStore?.quests;
    if (!quests) return [];
    return quests instanceof Map ? [...quests.values()] : Object.values(quests);
}

function checkNewQuests(quests: Quest[]) {
    // First run: remember what's already out without spamming toasts
    const firstRun = storage.seen == null;
    const seen = new Set<string>(storage.seen ?? []);
    const fresh = quests.filter(q => isActive(q) && !seen.has(q.id));
    if (!fresh.length && !firstRun) return;
    for (const q of fresh) seen.add(q.id);
    storage.seen = [...seen];
    if (firstRun || !storage.notifyNewQuests) return;
    for (const q of fresh) {
        const r = reward(q);
        showToast(`🆕 Nueva quest: ${q.config.messages.questName}${r ? ` (${r})` : ""}`, getAssetIDByName("QuestsIcon"));
    }
}

// Quests seen unfinished; only those can toast as completed
let unfinished = new Set<string>();

function onQuestStoreChange() {
    for (const q of allQuests()) {
        if (!q.userStatus?.completedAt) unfinished.add(q.id);
        else if (unfinished.delete(q.id) && storage.notifyCompleted)
            showToast(`✔️ Quest completada: ${q.config.messages.questName}`, getAssetIDByName("CheckmarkLargeIcon"));
    }
}

function onFetchSuccess({ quests }: { quests: Quest[]; }) {
    if (Array.isArray(quests)) checkNewQuests(quests);
}

function refresh() {
    try { QuestActions?.fetchCurrentQuests?.(); } catch (e) { console.error("[Questify] fetch failed", e); }
}

let interval: ReturnType<typeof setInterval> | undefined;
let startTimeout: ReturnType<typeof setTimeout> | undefined;

function QuestList() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
        const l = () => force(n => n + 1);
        QuestStore?.addChangeListener(l);
        return () => QuestStore?.removeChangeListener(l);
    }, []);
    if (!QuestStore) return <FormText style={{ margin: 16 }}>QuestStore not found in this Discord version.</FormText>;
    const pending = allQuests().filter(isPending);
    return (
        <FormSection title={`Unclaimed quests (${pending.length})`}>
            <FormRow label="Open Quests" leading={<FormRow.Icon source={getAssetIDByName("QuestsIcon")} />} onPress={() => openQuest()} />
            {pending.map(q => (
                <FormRow
                    key={q.id}
                    label={q.config.messages.questName}
                    subLabel={[reward(q), q.userStatus?.completedAt ? "completed, claim it" : null].filter(Boolean).join(" · ")}
                    onPress={() => openQuest(q)}
                />
            ))}
        </FormSection>
    );
}

export default {
    onLoad() {
        onQuestStoreChange();
        QuestStore?.addChangeListener(onQuestStoreChange);
        FluxDispatcher.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", onFetchSuccess);
        // Discord only fetches quests now and then, so ask for them ourselves
        startTimeout = setTimeout(refresh, 15_000);
        const minutes = Number(storage.checkInterval);
        if (minutes > 0) interval = setInterval(refresh, minutes * 60_000);
    },

    onUnload() {
        QuestStore?.removeChangeListener(onQuestStoreChange);
        FluxDispatcher.unsubscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", onFetchSuccess);
        unfinished = new Set();
        clearTimeout(startTimeout);
        clearInterval(interval);
    },

    settings() {
        useProxy(storage);
        return (
            <>
                <FormSection title="Settings">
                    <FormSwitchRow label="Toast when a new quest shows up" value={storage.notifyNewQuests} onValueChange={(v: boolean) => { storage.notifyNewQuests = v; }} />
                    <FormSwitchRow label="Toast when a quest is completed" value={storage.notifyCompleted} onValueChange={(v: boolean) => { storage.notifyCompleted = v; }} />
                    <FormInput
                        title="Minutes between quest checks (0 = only when Discord fetches them; restart the plugin to apply)"
                        keyboardType="numeric"
                        value={String(storage.checkInterval)}
                        onChange={(v: string) => { storage.checkInterval = Number(v) || 0; }}
                    />
                    <FormRow label="Check now" leading={<FormRow.Icon source={getAssetIDByName("RefreshIcon")} />} onPress={refresh} />
                </FormSection>
                <QuestList />
            </>
        );
    }
};
