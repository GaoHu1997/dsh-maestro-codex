# Original task renderer

Vendored from [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), version **0.28.2**, under MIT. See [LICENSE](LICENSE), [source-manifest.json](source-manifest.json), and [THIRD_PARTY_NOTICES](../../../../THIRD_PARTY_NOTICES).

The graph, tree, cards, layout, animations, popovers, job drawer and their styles are original source, not a visual reimplementation. Verbatim files are checked by SHA-256. Selected host declarations and the diagnostics transport adapter are identified separately in the manifest.

## Build adaptation

- `scripts/build-upstream.mjs` validates the original signatures and emits a declaration tree in ignored `.types/`. The strict Maestro client uses these declarations without weakening its own compiler flags.
- `scripts/build-upstream-css.mjs` compiles original CSS Modules into class maps and inline stylesheet text. The resolver maps declaration imports back to original source at runtime. The host need not discover separate CSS assets.
- The application shares the host's React, React DOM and UI primitives; only the original small `clsx` and `auto-animate` helpers are vendored, with their licenses.
- The CLI integration belongs outside this directory: [bridge.ts](../bridge.ts), [Board.tsx](../Board.tsx), and [cli-detail.tsx](../cli-detail.tsx). The only renderer extension is an optional `executor` field and a right-aligned CLI badge in the existing graph identity row/tree title row. These four additions are marked `adapted-cli-badge`; tests remove those exact additions and verify the original SHA-256, so all other renderer behavior and every original CSS rule remain unchanged.

Run `node scripts/build-upstream.mjs` before typecheck/test/build from the repository root. `tests/upstream-*.test.ts` checks source hashes, normalized CSS declarations/selectors/keyframes, 360px/920px graph layout, animation, original rendering, and the host module factory with shared React. These prove code/style parity, not a fabricated screenshot similarity percentage.
