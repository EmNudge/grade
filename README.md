# Grade

An open-source, node-based color grading environment for the web. Build a DAG of
color operations and apply them to footage in real time, on the GPU, via
**WebGPU**.

The core UI (node graph, viewer, inspector) ships built-in. Everything else —
node types, color transforms, scopes — is a plugin against a small, documented
node SDK.

<img width="1512" height="819" alt="Grade editor" src="https://github.com/user-attachments/assets/35d79d07-b9e9-4c1a-90ad-bb9464e15008" />

## Packages

| Package         | What it is                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `@grade/color`  | Color science: transfer functions, gamut matrices, and the WGSL snippets implementing them. Pure.     |
| `@grade/engine` | The WebGPU render graph. Compiles a node DAG into a chain of compute passes over GPU textures.        |
| `@grade/nodes`  | The node SDK + built-in nodes (Input, Color Space Transform, Contrast/Brightness, Output) + registry. |
| `apps/web`      | The editor: React Flow node graph, clip import, live WebGPU viewer, inspector.                        |

## Architecture

```
 import clip ──▶ [Input] ──▶ [Color Space Transform] ──▶ [Contrast/Brightness] ──▶ [Output] ──▶ viewer

 React Flow graph  ──compile──▶  @grade/engine render graph  ──▶  WGSL compute passes  ──▶  <canvas>
```

Each node declares its parameters and a WGSL compute kernel. The engine
topologically sorts the graph and runs one compute pass per node, ping-ponging
between GPU textures. Adding a node type = registering a definition; that
registry is the plugin seam. GPU code is isolated so a WebGL2 fallback can land
later behind the same interface.

## Development

Install [proto](https://moonrepo.dev/proto):

```sh
bash <(curl -fsSL https://moonrepo.dev/install/proto.sh)
```

From the repo root:

```sh
proto use      # installs bun + moon at the versions pinned in .prototools
bun install
moon run web:dev   # http://localhost:5173
```

Open the editor in a WebGPU-capable browser (Chrome/Edge 113+).

## License

MIT
