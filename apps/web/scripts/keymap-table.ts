import { herdrAppTable } from "../src/keys/herdr-app-table.ts";

const target = new URL("../../../docs/keymap-herdr-app.md", import.meta.url);
await Bun.write(target, herdrAppTable());
console.log(`wrote ${target.pathname}`);
