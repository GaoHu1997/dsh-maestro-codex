# Original task renderer

Vendored from [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), version **0.28.2**, under MIT. See [LICENSE](LICENSE), [source-manifest.json](source-manifest.json), and [THIRD_PARTY_NOTICES](../../../../THIRD_PARTY_NOTICES).

The graph, tree, cards, layout, animations, popovers, job drawer and their styles are original source, not a visual reimplementation. Verbatim files are checked by SHA-256. Selected host declarations and the diagnostics transport adapter are identified separately in the manifest.

## Build adaptation

- `scripts/build-upstream.mjs` validates the original signatures and emits a declaration tree in ignored `.types/`. The strict Maestro client uses these declarations without weakening its own compiler flags.
- `scripts/build-upstream-css.mjs` compiles original CSS Modules into class maps and inline stylesheet text. The resolver maps declaration imports back to original source at runtime. The host need not discover separate CSS assets.
- The application shares the host's React, React DOM and UI primitives; only the original small `clsx` and `auto-animate` helpers are vendored, with their licenses.
- Maestro integration belongs outside this directory: [bridge.ts](../bridge.ts), [Board.tsx](../Board.tsx), and [cli-detail.tsx](../cli-detail.tsx). Four files are marked `adapted-cli-badge-and-interrupted-state`: an optional `executor` badge, opt-in CLI `stateText` in the existing state slot and accessible names, and a scoped CLI state map applied before original folding. Interrupted CLI tasks use idle/waiting semantics without falsifying native running facts; completed siblings still fold normally. Native nodes without these opt-in fields retain the original renderer output. Tests remove each exact, single-occurrence insertion or replacement and verify independently pinned original 0.28.2 SHA-256 values; layout, animation and CSS stay verbatim.

Run `node scripts/build-upstream.mjs` before typecheck/test/build from the repository root. `tests/upstream-*.test.ts` checks source hashes, normalized CSS declarations/selectors/keyframes, 360px/920px graph layout, animation, original rendering, and the host module factory with shared React. These prove code/style parity, not a fabricated screenshot similarity percentage.
