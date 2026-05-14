import { WebIO } from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import { convertScadToGltf } from "openscad-gltf-wasm/convert";

// --- Helper logic ---
function uint8ArrayToBase64(u8a) {
  if (typeof Buffer !== "undefined") return Buffer.from(u8a).toString("base64");
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < u8a.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, u8a.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Compiles SCAD to GLTF, applying optional auto-smooth, compression, and absolute resizing.
 * @param {string} scadCode - The raw SCAD input.
 * @param {Object} options - Configuration options.
 * @returns {Promise<Uint8Array | string>} Final GLTF data.
 */
export async function processScad(scadCode, options = {}) {
  const { wasmUrl, binary = true, compression = false, resize } = options;

  // We force a binary output whenever we need to perform extra transforms natively via `convertScadToGltf`
  const requireBinaryIntermediate =
    compression || binary || resize !== undefined;

  if (!compression && resize === undefined) {
    return await convertScadToGltf(scadCode, {
      wasmUrl,
      binary: requireBinaryIntermediate,
    });
  }

  // Fetch raw binary GLB first directly via WASM
  const rawResultData = await convertScadToGltf(scadCode, {
    wasmUrl,
    binary: true,
  });

  // Initialize transformation processing
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  const io = new WebIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder,
    });

  let dataToRead = rawResultData;
  if (typeof dataToRead === "string") {
    dataToRead = new TextEncoder().encode(dataToRead);
  }

  const document = await io.readBinary(dataToRead);

  // Apply absolute resizing based on bounding box
  if (typeof resize === "number" && resize > 0) {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let hasGeometry = false;

    // SCAD to GLTF inherently generates flattened world-space vertices without nested node transforms
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        const positionAcc = primitive.getAttribute("POSITION");
        if (!positionAcc) continue;

        const min = positionAcc.getMin([]);
        const max = positionAcc.getMax([]);

        if (min && min.length >= 3 && max && max.length >= 3) {
          minX = Math.min(minX, min[0]);
          minY = Math.min(minY, min[1]);
          minZ = Math.min(minZ, min[2]);
          maxX = Math.max(maxX, max[0]);
          maxY = Math.max(maxY, max[1]);
          maxZ = Math.max(maxZ, max[2]);
          hasGeometry = true;
        } else {
          const arr = positionAcc.getArray();
          if (arr) {
            for (let i = 0; i < arr.length; i += 3) {
              minX = Math.min(minX, arr[i]);
              minY = Math.min(minY, arr[i + 1]);
              minZ = Math.min(minZ, arr[i + 2]);
              maxX = Math.max(maxX, arr[i]);
              maxY = Math.max(maxY, arr[i + 1]);
              maxZ = Math.max(maxZ, arr[i + 2]);
              hasGeometry = true;
            }
          }
        }
      }
    }

    if (hasGeometry) {
      const dimX = maxX - minX;
      const dimY = maxY - minY;
      const dimZ = maxZ - minZ;
      const maxDim = Math.max(dimX, dimY, dimZ);

      if (maxDim > 0) {
        const scaleFactor = resize / maxDim;

        // Apply corrective scale to root nodes
        for (const scene of document.getRoot().listScenes()) {
          for (const node of scene.listChildren()) {
            const currentScale = node.getScale();
            node.setScale([
              currentScale[0] * scaleFactor,
              currentScale[1] * scaleFactor,
              currentScale[2] * scaleFactor,
            ]);
          }
        }
      }
    }
  }

  if (compression) {
    await document.transform(
      meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    );
  }

  if (binary || compression) {
    if (compression && !binary) {
      console.warn("Meshopt compression forces binary output. Outputting GLB.");
    }
    return await io.writeBinary(document);
  } else {
    // Exporting as a completely standalone textual .gltf
    const { json, resources } = await io.writeJSON(document);
    for (const buffer of json.buffers || []) {
      if (resources[buffer.uri]) {
        const u8a = resources[buffer.uri];
        const base64 = uint8ArrayToBase64(u8a);
        buffer.uri = `data:application/octet-stream;base64,${base64}`;
      }
    }
    return JSON.stringify(json, null, 2);
  }
}
