import { config } from "zod/v4";
export * from "zod/v4";
export { default } from "zod/v4";

// Set before importing typevault's schemas: even Zod's caught eval probe violates the hosted CSP.
config({ jitless: true });
