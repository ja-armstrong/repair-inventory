/**
 * The client sandbox seam (sandbox spec decision 3): ONE built dist serves
 * both environments, so every environment-dependent answer is derived here,
 * once, from where the page was loaded — no `import.meta.env` builds, no
 * second bundle. The page cannot move between environments after load, so
 * deriving at module load is exact, not a snapshot.
 */
export const isSandbox: boolean = window.location.pathname.startsWith("/sandbox");

/**
 * Prefix for every API request path: "" in prod, "/sandbox" in the sandbox.
 * The sandbox app mounts the same domain routes under /sandbox (Express
 * prefix-strips), so prefixing the path is all a client request needs.
 */
export const apiBase: string = isSandbox ? "/sandbox" : "";
