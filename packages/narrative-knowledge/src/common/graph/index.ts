/**
 * Public surface of the separable graph core (AD-6 / UR-029).
 *
 * Everything the core needs lives under this folder, and this barrel is what
 * the rest of `src/common` reads. The reverse direction (`src/common/*`
 * importing from here) is EXPECTED and allowed; the forbidden direction is
 * this folder reaching outward — prohibition (e), half 2.
 */
export * from './graph-node';
export * from './graph-edge';
