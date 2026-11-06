# RevengePlugins

Ports of my Vencord user plugins to Discord Android (Revenge / Kettu, Vendetta plugin format).

| Plugin | What it does on mobile |
|---|---|
| `fgfTools` | 🛄 CLAIM link under Epic Games / GOG giveaway messages. Long-press a message > **Claim All (itch.io)** (needs the itch.io cookie in settings). |
| `steamIntegration` | 🎮 badge under Steam game messages: owned / wishlist, DLC, limited, cards, bundles, achievements. Long-press > **Steam info**. Ownership needs the `steamLoginSecure` cookie in settings. |
| `questify` | Toasts for new and completed quests, periodic checks, unclaimed quests list in settings. |

Cookies are stored only in the plugin storage on the phone, never in this repo.

## Install
Revenge/Kettu settings > Plugins > + and paste `<pages url>/<plugin>/`.

## Build
```
pnpm install
pnpm build          # or: pnpm build fgfTools
```
Output goes to `dist/<plugin>/` (`index.js` + `manifest.json`); `dist/` is committed so GitHub Pages can serve it.
