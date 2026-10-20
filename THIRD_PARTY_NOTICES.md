# Third-party notices

exidraw's own source code is licensed under the [MIT License](LICENSE). This
repository contains no code copied from other projects. Third-party software
enters only through dependencies and build artifacts, and keeps its own
license.

## What is distributed where

| Artifact | Contains | Notices shipped with it |
|---|---|---|
| This repository | Our source code and dependency manifests only | This file |
| Web bundle (`web/dist`) | Bundled npm packages, Excalidraw fonts | `third-party-licenses.txt`, `excalidraw-assets/fonts/LICENSES.txt` |
| Renderer bundle (`server/renderer-dist`) | Bundled npm packages, Excalidraw fonts | `fonts/LICENSES.txt` |
| Container image | Everything above, `node_modules`, Node.js, Debian packages, Chromium | `/app/LICENSE`, `/app/THIRD_PARTY_NOTICES.md`, `/app/third-party-licenses.txt`, `/usr/share/doc/*/copyright`, Chromium's `LICENSE.headless_shell` |

`third-party-licenses.txt` is generated at build time from the production
dependency tree (`npm run licenses`). The same script fails the build if a
production dependency has a license outside the permissive allowlist.

## Main components

| Component | License | Use |
|---|---|---|
| [Excalidraw](https://github.com/excalidraw/excalidraw) (`@excalidraw/excalidraw`) | MIT, © 2020 Excalidraw | Editor component, used unmodified as a library |
| `@excalidraw/mermaid-to-excalidraw`, `mermaid` | MIT | Mermaid conversion in the renderer |
| React, React Router | MIT | Web app |
| Hono, `@hono/node-server`, `ws`, `pino`, `zod`, `openid-client` | MIT | Server |
| `@modelcontextprotocol/sdk` | MIT | MCP endpoint |
| Playwright | Apache-2.0 (with NOTICE) | Drives the headless renderer |
| Node.js | MIT plus bundled third-party licenses | Runtime (base image) |

The production dependency tree is MIT, ISC, Apache-2.0, BSD, 0BSD, CC0,
Unlicense and Zlib. Two packages need a note:

- `khroma` declares no `license` field; its license file is MIT.
- `dompurify` is `MPL-2.0 OR Apache-2.0`; we use it under Apache-2.0.

The design of the collaboration client and the merge rule follow Excalidraw's
own collaboration app; the code is an independent implementation.

## Fonts

The Excalidraw fonts are copied unmodified from `@excalidraw/excalidraw` at
build time. They are not stored in this repository.

| Family | License |
|---|---|
| Virgil | SIL OFL 1.1, © 2011 Your Own Font Foundry |
| Excalifont | SIL OFL 1.1, © 2024 Excalidraw. "Excalifont" is a trademark of Excalidraw. |
| Xiaolai SC | SIL OFL 1.1, © 2020 LXGW |
| Nunito | SIL OFL 1.1, © The Nunito Project Authors |
| Lilita One | SIL OFL 1.1, Reserved Font Name "Lilita One" |
| Assistant | SIL OFL 1.1, Reserved Font Name "Source" |
| Cascadia Code | SIL OFL 1.1, © Microsoft Corporation |
| Comic Shanns | MIT, © Shannon Miwa and contributors |
| Liberation Sans 1.05 | GPL-2.0 with font exception, © 2007 Ascender Corp |

## Container image

The image is based on `node:24-bookworm-slim` (Debian 12). Playwright installs
the Chrome for Testing headless shell (Chromium 156.0.8078.4) and the Debian
packages it needs, including fonts. These are distributed unmodified as
separate programs; their licenses (BSD-3-Clause for Chromium, LGPL for FFmpeg,
GPL/LGPL/MPL for various Debian packages, and others) are in
`/ms-playwright/*/chrome-headless-shell-linux64/LICENSE.headless_shell` and
`/usr/share/doc/*/copyright`. Corresponding sources are available from
[Debian](https://sources.debian.org/) and the
[Chromium project](https://source.chromium.org/chromium).
