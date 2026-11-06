// Builds each plugin in src/<plugin>/ to dist/<plugin>/{index.js,manifest.json}
// in the Vendetta format Revenge and Kettu load: the loader evals
// `vendetta=>{return <index.js>}`, so @vendetta/* imports map to that argument.
import { build } from "esbuild";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";

const plugins = {
    fgfTools: { name: "FGFTools", description: "Claim All for itch.io, CLAIM for Epic Games / GOG giveaways (r/FreeGameFindings)", icon: "GiftIcon" },
    steamIntegration: { name: "Steam Integration", description: "Steam owned / wishlist / cards / achievements / bundles badge under Steam game messages", icon: "GameControllerIcon" },
    questify: { name: "Questify", description: "Toasts for new and completed quests, and a list of unclaimed quests", icon: "QuestsIcon" }
};

const vendetta = {
    name: "vendetta",
    setup(b) {
        b.onResolve({ filter: /^@vendetta\/?/ }, ({ path }) => ({ path, namespace: "vendetta" }));
        b.onLoad({ filter: /.*/, namespace: "vendetta" }, ({ path }) => ({
            contents: `module.exports = ${path.slice(1).replace(/\//g, ".")}`, loader: "js"
        }));
    }
};

const only = process.argv.slice(2);
for (const [id, meta] of Object.entries(plugins)) {
    if (only.length && !only.includes(id)) continue;
    const out = `dist/${id}`;
    mkdirSync(out, { recursive: true });
    await build({
        entryPoints: [`src/${id}/index.tsx`],
        bundle: true,
        outfile: `${out}/index.js`,
        format: "iife",
        globalName: "$",
        banner: { js: "(()=>{" },
        footer: { js: "return $;})();" },
        target: "es2016",
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        inject: ["scripts/react-shim.js"],
        minify: true,
        legalComments: "none",
        logLevel: "warning",
        plugins: [vendetta]
    });
    const js = readFileSync(`${out}/index.js`);
    writeFileSync(`${out}/manifest.json`, JSON.stringify({
        name: meta.name,
        description: meta.description,
        authors: [{ name: "OsuCelsius", id: "0" }],
        main: "index.js",
        hash: createHash("sha256").update(js).digest("hex"),
        vendetta: { icon: meta.icon }
    }, null, 2));
    console.log(`${id}: ${(js.length / 1024).toFixed(1)} KB`);
}
