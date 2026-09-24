// scripts/coord/posix-target.mjs — plan 4096 T1: ONE spelling of "make this path POSIX", moved
// here from nightly-windows-suite.mjs (which re-exports it). The land spine's `toPosixPath` alias
// needs it and the spine is core, so it may not import that module. Imports nothing.
//
// A target file built with the PLATFORM'S OWN `path.join` separator (a backslash on Windows)
// meets reporter-event paths already normalized to POSIX; normalizing the target side too lets
// both sides of a completeness comparison land on the identical convention regardless of which
// platform built the list.
export function normalizeTargetToPosix(target) {
  return String(target).replace(/\\/g, '/');
}
