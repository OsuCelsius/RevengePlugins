// Discord mobile hooks shared by the plugins (patterns from nexpid/RevengePlugins)

import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

export const MessageStore = findByStoreName("MessageStore");

function getNativeModule(...names: string[]): any {
    const nmp = (window as any).nativeModuleProxy;
    for (const name of names) {
        const tm = (globalThis as any).__turboModuleProxy?.(name);
        if (tm) return tm;
        if (nmp?.[name]) return nmp[name];
    }
}

const ChatModule = getNativeModule("NativeChatModule", "DCDChatManager");

// Messages are rendered natively from JSON rows. cb gets each message row
// plus the store message, and can push nodes into row.message.content
export type Node = { type: string; content?: string | Node[]; target?: string; [k: string]: any; };
export const INVISIBLE = "\x00";

function stripInvisible(nodes: Node[] | undefined) {
    for (const n of nodes ?? []) {
        if (typeof n.content === "string") n.content = n.content.replace(/^\x00+/, "");
        else if (Array.isArray(n.content)) stripInvisible(n.content);
        if (Array.isArray(n.items)) stripInvisible(n.items);
    }
}

export function patchRows(cb: (row: any, message: any) => void) {
    if (!ChatModule?.updateRows) return () => { };
    return before("updateRows", ChatModule, args => {
        let rows: any[];
        try { rows = JSON.parse(args[1]); } catch { return; }
        let changed = false;
        for (const row of rows) {
            const m = row?.message;
            if (row?.type !== 1 || !m?.id) continue;
            stripInvisible(m.content);
            const msg = MessageStore?.getMessage(m.channelId, m.id);
            if (!msg) continue;
            try { cb(row, msg); changed = true; } catch (e) { console.error("[RevengePlugins] row patch", e); }
        }
        if (changed) args[1] = JSON.stringify(rows);
    });
}

export function appendNodes(row: any, nodes: Node[]) {
    const m = row.message;
    m.content ??= [];
    if (m.content.length) m.content.push({ type: "text", content: "\n" });
    m.content.push(...nodes);
}

export const text = (content: string): Node => ({ type: "text", content });
export const link = (label: string, target: string): Node => ({ type: "link", target, content: [text(label)] });

// Makes Discord rebuild one message row (after async data arrives) by
// toggling an invisible prefix on its content; patchRows strips it again
export function rerender(channelId: string, id: string) {
    const m = MessageStore?.getMessage(channelId, id);
    if (!m) return;
    const content: string = m.content ?? "";
    FluxDispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message: { ...m, content: content.startsWith(INVISIBLE) ? content.slice(1) : INVISIBLE + content },
        log_edit: false,
        otherPluginBypass: true
    });
}

// ---------- long-press message menu ----------
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;

export interface MenuItem { label: string; icon?: number; onPress(): void; }

function MenuRow({ item }: { item: MenuItem; key?: string; }) {
    const onPress = () => {
        LazyActionSheet?.hideActionSheet();
        item.onPress();
    };
    if (ActionSheetRow)
        return <ActionSheetRow label={item.label} icon={item.icon != null ? <ActionSheetRow.Icon source={item.icon} /> : undefined} onPress={onPress} />;
    return <Forms.FormRow label={item.label} leading={item.icon != null ? <Forms.FormRow.Icon source={item.icon} /> : undefined} onPress={onPress} />;
}

export function patchMessageMenu(getItems: (message: any) => MenuItem[]) {
    if (!LazyActionSheet) return () => { };
    return before("openLazy", LazyActionSheet, ([component, key, msg]) => {
        const message = msg?.message;
        if (key !== "MessageLongPressActionSheet" || !message) return;
        let items: MenuItem[];
        try { items = getItems(message); } catch { return; }
        if (!items.length) return;
        component.then((mod: any) => {
            const unpatch = after("default", mod, (_, tree) => {
                React.useEffect(() => () => { unpatch(); }, []);
                const buttons = findInReactTree(tree, (x: any) => Array.isArray(x) && x[0]?.type?.name === "ButtonRow");
                if (!buttons) return tree;
                buttons.splice(0, 0, ...items.map((item, i) => <MenuRow key={"rp-" + i} item={item} />));
                return tree;
            });
        });
    });
}
