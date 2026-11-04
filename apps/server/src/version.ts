import rootPackage from "../../../package.json" with { type: "json" };

/** App version, from the root package.json (inlined at build time). */
export const VERSION: string = rootPackage.version;
