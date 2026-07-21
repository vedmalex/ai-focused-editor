// The project builds with classic `moduleResolution: "node"`, which ignores the
// package.json `exports` map, so the `/registry` and `/registry/fs` subpaths do
// not resolve on their own (same reason ai-connect-local.d.ts / -browser.d.ts
// exist). Unlike those, the registry surface is DISTINCT from the main entry
// (ConnectionRegistry, RegistryEndpoint, the write-API types), so these ambient
// declarations re-export from the real declaration files by their in-package path.
declare module '@vedmalex/ai-connect/registry' {
  export * from '@vedmalex/ai-connect/dist/types/registry/index';
}

declare module '@vedmalex/ai-connect/registry/fs' {
  export * from '@vedmalex/ai-connect/dist/types/registry/fs';
}
