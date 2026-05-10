# OpenSCAD GLTF Bridge

A powerful JavaScript bridge for compiling OpenSCAD (`.scad`) directly to **glTF/GLB** with advanced post-processing features.

This package wraps the [openscad-gltf-wasm](https://github.com/iliagrigorevdev/openscad-gltf-wasm) engine and enhances it using [`@gltf-transform`](https://gltf-transform.dev/) and [`meshoptimizer`](https://github.com/zeux/meshoptimizer). Standard OpenSCAD exports models with flat faceted normals; this bridge introduces **Auto-Smoothing** (via crease angles) and **Meshopt Compression**, resulting in beautiful, web-ready 3D assets.

## Features

- **Direct Compilation:** Converts SCAD to GLB/glTF completely in JS (Node.js or Browser).
- **Auto-Smoothing:** Automatically computes smooth vertex normals for your geometry based on a customizable crease angle threshold.
- **Meshopt Compression:** Drastically reduces final file sizes using `EXT_meshopt_compression` via `meshoptimizer`.
- **Flexible Output:** Export as a binary `.glb` (`Uint8Array`) or a completely self-contained textual `.gltf` (JSON string with inline base64 buffers).
- **Inherited Power:** Supports all the custom PBR materials and skeletal animations introduced by `openscad-gltf-wasm`.

## Installation

```bash
npm install github:iliagrigorevdev/openscad-gltf-bridge
```

## Usage

### Usage in Node.js

Because the underlying WebAssembly module expects a browser environment, it tries to use `fetch()` to load the `.wasm` file. In Node.js, `fetch` does not support local `file://` paths.

To bypass this, we provide the absolute path to the `.wasm` file and briefly mock `global.fetch` to read the file from disk using Node's `fs` module:

```javascript
import { processScad } from "openscad-gltf-bridge";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 1. Locate the WASM file inside node_modules
const wasmPath = path.resolve("node_modules/openscad-gltf-wasm/openscad.wasm");

// 2. Mock fetch to allow the WASM loader to read local files in Node.js
global.fetch = async (url) => {
  const normalizedPath = url.toString().startsWith("file://")
    ? fileURLToPath(url.toString())
    : url.toString();

  const buffer = fs.readFileSync(normalizedPath);
  return new Response(buffer, {
    status: 200,
    headers: { "Content-Type": "application/wasm" }
  });
};

const scadCode = `
  $fn = 64;
  color("gold", metalness=1.0, roughness=0.2)
  sphere(r=10);
`;

async function build() {
  // Compile, smooth the normals, and compress the output!
  const gltfData = await processScad(scadCode, {
    wasmUrl: \`file://\${wasmPath}\`,
    autoSmooth: true,
    creaseAngle: 30,
    compression: true,
    binary: true
  });

  fs.writeFileSync("output.glb", gltfData);
  console.log("Saved smoothed and compressed output.glb");
}

build();
```

### Usage in the Browser (Vite / Webpack)

If you are using this inside a browser, you don't need to mock `fetch`. You just need to provide the URL to the underlying `openscad.wasm` file so the bundler and loader can fetch it over HTTP.

```javascript
// Example using Vite's ?url syntax to get the public path to the asset
import wasmUrl from "openscad-gltf-wasm/openscad.wasm?url";
import { processScad } from "openscad-gltf-bridge";

const scadCode = `cylinder(h=20, r=5);`;

const gltfData = await processScad(scadCode, {
  wasmUrl,
  autoSmooth: true,
});

// gltfData is a Uint8Array that can be converted to a Blob and downloaded,
// or passed directly to Three.js / Babylon.js loaders.
```

## API Reference

### `processScad(scadCode, options)`

**Arguments:**

- `scadCode` _(string)_: The raw OpenSCAD script.
- `options` _(Object)_: Configuration options (see below).

**Returns:**

- `Promise<Uint8Array | string>`: Returns a `Uint8Array` (binary GLB) by default, or a `string` (JSON glTF) if `binary: false` is set without compression.

#### Options

| Option        | Type      | Default     | Description                                                                                                                                                  |
| ------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wasmUrl`     | `string`  | `undefined` | URL to the Emscripten WASM file. Required so the engine knows where to load the binary.                                                                      |
| `autoSmooth`  | `boolean` | `false`     | Unwelds geometry, computes smooth vertex normals based on `creaseAngle`, and rewields. Fixes OpenSCAD's default "flat/faceted" look.                         |
| `creaseAngle` | `number`  | `30`        | Angle threshold (in degrees) for auto-smoothing. Faces with an angle less than this will be smoothed together.                                               |
| `compression` | `boolean` | `false`     | Applies Meshopt compression (`EXT_meshopt_compression`). _Note: This forces a binary output._                                                                |
| `binary`      | `boolean` | `true`      | If `true`, returns a `.glb` as a `Uint8Array`. If `false` (and compression is off), returns a standalone `.gltf` string with inline base64 embedded buffers. |

## Why use this over `openscad-gltf-wasm`?

The base package `openscad-gltf-wasm` is excellent for raw extraction of geometry, PBR materials, and animations from SCAD files. However, raw SCAD geometry often contains detached faces and flat normals, meaning round objects (like `sphere()` or `cylinder()`) look faceted.

`openscad-gltf-bridge` reads the raw binary output, traverses the mesh utilizing `@gltf-transform/core`, recalculates adjacent normals to create smooth surfaces, trims away detached vertices, applies compression, and returns a highly optimized, modern asset ready for your rendering engine.

## License

See the `LICENSE` file (GPL-2.0 or later, inheriting from from standard OpenSCAD).
