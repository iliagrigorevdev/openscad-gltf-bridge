# OpenSCAD GLTF Bridge

A powerful JavaScript bridge for compiling OpenSCAD (`.scad`) directly to **glTF/GLB** with advanced post-processing features.

This package wraps the [openscad-gltf-wasm](https://github.com/iliagrigorevdev/openscad-gltf-wasm) engine and enhances it using [`@gltf-transform`](https://gltf-transform.dev/) and [`meshoptimizer`](https://github.com/zeux/meshoptimizer). It provides **Meshopt Compression** and absolute resizing functionality, resulting in beautiful, web-ready 3D assets.

## Features

- **CLI Batch Builder:** Automate the build process for multiple assets using a simple `scad.config.json` file.
- **Direct Compilation:** Converts SCAD to GLB/glTF completely in JS (Node.js or Browser).
- **Meshopt Compression:** Drastically reduces final file sizes using `EXT_meshopt_compression` via `meshoptimizer`.
- **Absolute Resizing:** Need consistent scales? Set the `resize` parameter to uniformly scale the entire model so its largest dimension natively equals a fixed real-world value (like standardizing models to exactly 5 meters wide).
- **Flexible Output:** Export as a binary `.glb` (`Uint8Array`) or a completely self-contained textual `.gltf` (JSON string with inline base64 embedded buffers).
- **Inherited Power:** Supports all the custom PBR materials and skeletal animations introduced by `openscad-gltf-wasm`.

## Installation

Choose the installation method that fits your workflow:

### 1. For Asset Generation (CLI Workflow)

If you only need to generate 3D assets during your project's build process, install it as a **development dependency**. This ensures the OpenSCAD engine is not included in your final production bundle.

```bash
npm install --save-dev github:iliagrigorevdev/openscad-gltf-bridge
```

### 2. For Runtime Integration (Library Workflow)

If you are building a CAD tool or a web app that compiles OpenSCAD code on-the-fly in the browser or on a server, install it as a **regular dependency**.

```bash
npm install github:iliagrigorevdev/openscad-gltf-bridge
```

## Usage

### Usage via API (scad-serve)

If you're building a web IDE or an automated system that needs to manipulate your OpenSCAD pipeline remotely, we provide an Express.js based API server, `scad-serve`.

Start the server using one of these options:

- **Option A: Run directly (No installation)**
  ```bash
  npx -p github:iliagrigorevdev/openscad-gltf-bridge scad-serve
  ```
- **Option B: If installed as a dev-dependency**
  ```bash
  npx scad-serve
  ```

**Optional Arguments:**

- `--port 3000`: Set a custom port (default is 3000).
- `my-config.json`: Specify a custom config filename (default is `scad.config.json`).

**Available Endpoints:**

- `GET /api/config`: Returns the entire `scad.config.json` content.
- `POST /api/config`: Completely overwrites the `scad.config.json`.
- `GET /api/models?input=MyModel`: Retrieves the raw text content of a `.scad` file from the filesystem.
- `POST /api/models`: Creates or updates a `.scad` file in the filesystem (under `inputDir`) and registers it in the config.
  - **Body:** `{ "input": "MyModel", "content": "cube(10);", "options": { "resize": 5 } }`
- `PATCH /api/models`: Updates only the build options for an existing registered model without changing its file contents.
  - **Body:** `{ "input": "MyModel", "options": { "resize": 5 } }`
- `POST /api/models/build`: Builds a specific model, waits for completion, and returns the resulting `.glb`/`.gltf` file directly.
  - **Body:** `{ "input": "MyModel" }`

### Usage via CLI (scad-build)

The easiest way to process multiple files locally in a project is using the built-in `scad-build` CLI. It automatically handles WASM loading and file reading for you!

1. Create a `scad.config.json` file in your project root:

```json
{
  "inputDir": "./assets",
  "outDir": "./public/models",
  "assets": [
    {
      "input": "SpaceShip",
      "options": {
        "resize": 5
      }
    },
    {
      "input": "Alien",
      "options": {
        "compression": true
      }
    },
    {
      "input": "Planet",
      "output": "CustomPlanetName"
    }
  ]
}
```

2. Run the build command using one of these options:

- **Option A: Run directly (No installation)**
  ```bash
  npx -p github:iliagrigorevdev/openscad-gltf-bridge scad-build
  ```
- **Option B: If installed as a dev-dependency**
  ```bash
  npx scad-build
  ```

**Optional Arguments:**

- `custom-scad.config.json`: Specify a custom config file.
- `--filter SpaceShip`: Only build models matching this name (case-insensitive).
- `--force`: Rebuild all assets even if they haven't changed.

### Usage in Node.js (Manual)

If you prefer to write your own build scripts, note that the underlying WebAssembly module expects a browser environment and tries to use `fetch()` to load the `.wasm` file. In Node.js, `fetch` does not support local `file://` paths.

To bypass this, mock `global.fetch` to read the file from disk using Node's `fs` module:

```javascript
import { processScad } from "openscad-gltf-bridge";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// 1. Locate the WASM file inside node_modules
const require = createRequire(import.meta.url);
const wasmPath = require.resolve("openscad-gltf-wasm/openscad.wasm");

// 2. Mock fetch to allow the WASM loader to read local files in Node.js
global.fetch = async (url) => {
  const normalizedPath = url.toString().startsWith("file://")
    ? fileURLToPath(url.toString())
    : url.toString();

  const buffer = fs.readFileSync(normalizedPath);
  return new Response(buffer, {
    status: 200,
    headers: { "Content-Type": "application/wasm" },
  });
};

const scadCode = `
  $fn = 64;
  color("gold", metalness=1.0, roughness=0.2)
  sphere(r=10);
`;

async function build() {
  // Compile, resize absolute dimension, and compress output!
  const gltfData = await processScad(scadCode, {
    wasmUrl: `file://${wasmPath}`,
    compression: true,
    resize: 2, // The resulting sphere will be exactly 2 meters/units across
    binary: true,
  });

  fs.writeFileSync("output.glb", gltfData);
  console.log("Saved compressed output.glb");
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
| `resize`      | `number`  | `undefined` | Calculates the model's bounding box and uniformly scales the root so that its largest dimension (width/height/depth) equals this absolute value.             |
| `compression` | `boolean` | `false`     | Applies Meshopt compression (`EXT_meshopt_compression`). _Note: This forces a binary output._                                                                |
| `binary`      | `boolean` | `true`      | If `true`, returns a `.glb` as a `Uint8Array`. If `false` (and compression is off), returns a standalone `.gltf` string with inline base64 embedded buffers. |

## Why use this over `openscad-gltf-wasm`?

The base package `openscad-gltf-wasm` is excellent for raw extraction of geometry, PBR materials, and animations from SCAD files. However, if you need to post-process the output, `openscad-gltf-bridge` reads the raw binary output, traverses the mesh utilizing `@gltf-transform/core`, applies absolute resizing, compresses the mesh using Meshoptimizer, and returns a highly optimized, modern asset ready for your rendering engine.

## License

See the `LICENSE` file (GPL-2.0 or later, inheriting from standard OpenSCAD).
