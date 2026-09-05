/**
 * @darkforest/contracts
 *
 * The shared truth between client, server and every module. Schemas are defined
 * once here; TypeScript types are inferred from them, never written twice.
 *
 * Rule: if a shape crosses a module boundary, it is declared here. If it does not,
 * it belongs in that module's own types.ts.
 */

export * from "./ids.js";
export * from "./ai.js";
export * from "./memory.js";
export * from "./character.js";
export * from "./world.js";
export * from "./events.js";
