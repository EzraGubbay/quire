# vendor

Temporary tarballs of `@ezragubbay/core` and `@ezragubbay/folio`, packed from `~/.design` with `pnpm pack`, so the app and CI can build before the design packages are published to npm. Once published, switch `apps/web/package.json` to version ranges, drop the `pnpm.overrides` entry in the root `package.json`, and delete this folder.

Refresh: `cd ~/.design/packages/folio && pnpm build && pnpm pack --pack-destination <repo>/vendor` (same for core), then `pnpm install`.
