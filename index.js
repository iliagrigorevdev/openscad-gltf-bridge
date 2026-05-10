import { WebIO } from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt, unweld, prune } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import { convertScadToGltf } from "openscad-gltf-wasm/convert";

// --- Internal Math Logic ---
function computeSmoothNormals(positions, creaseAngle) {
  const hashToVertices = new Map();
  const vertexNormals = new Float32Array(positions.length);

  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i],
      ay = positions[i + 1],
      az = positions[i + 2];
    const bx = positions[i + 3],
      by = positions[i + 4],
      bz = positions[i + 5];
    const cx = positions[i + 6],
      cy = positions[i + 7],
      cz = positions[i + 8];

    const cbx = cx - bx,
      cby = cy - by,
      cbz = cz - bz;
    const abx = ax - bx,
      aby = ay - by,
      abz = az - bz;

    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;

    let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len === 0) len = 1;
    const normal = { x: nx / len, y: ny / len, z: nz / len };

    for (let j = 0; j < 3; j++) {
      const vIdx = i + j * 3;
      const x = positions[vIdx];
      const y = positions[vIdx + 1];
      const z = positions[vIdx + 2];
      const hash = `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}_${Math.round(z * 1e4)}`;

      let list = hashToVertices.get(hash);
      if (!list) {
        list = [];
        hashToVertices.set(hash, list);
      }
      list.push({ index: vIdx, faceNormal: normal });
    }
  }

  // Convert degrees to radians for the cosine check
  const cosAngle = Math.cos(creaseAngle * (Math.PI / 180));

  for (const list of hashToVertices.values()) {
    const adj = Array.from({ length: list.length }, () => []);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const dot =
          list[i].faceNormal.x * list[j].faceNormal.x +
          list[i].faceNormal.y * list[j].faceNormal.y +
          list[i].faceNormal.z * list[j].faceNormal.z;
        if (dot >= cosAngle - 0.0001) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }

    const visited = new Array(list.length).fill(false);
    for (let i = 0; i < list.length; i++) {
      if (!visited[i]) {
        const component = [];
        const q = [i];
        visited[i] = true;
        while (q.length > 0) {
          const curr = q.shift();
          component.push(curr);
          for (const neighbor of adj[curr]) {
            if (!visited[neighbor]) {
              visited[neighbor] = true;
              q.push(neighbor);
            }
          }
        }

        let nx = 0,
          ny = 0,
          nz = 0;
        for (const idx of component) {
          nx += list[idx].faceNormal.x;
          ny += list[idx].faceNormal.y;
          nz += list[idx].faceNormal.z;
        }
        let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len === 0) len = 1;

        nx /= len;
        ny /= len;
        nz /= len;

        for (const idx of component) {
          const v = list[idx];
          vertexNormals[v.index] = nx;
          vertexNormals[v.index + 1] = ny;
          vertexNormals[v.index + 2] = nz;
        }
      }
    }
  }

  return vertexNormals;
}

function autoSmoothPrimitive(document, primitive, creaseAngle) {
  const positionAccessor = primitive.getAttribute("POSITION");
  if (!positionAccessor) return;

  const positions = positionAccessor.getArray();
  const normals = computeSmoothNormals(positions, creaseAngle);

  const semantics = primitive.listSemantics();
  const accessors = semantics.map((sem) => primitive.getAttribute(sem));
  const attrArrays = accessors.map((a) => a.getArray());
  const attrElementSizes = accessors.map((a) => a.getElementSize());

  const vertexCount = positionAccessor.getCount();

  const weldedArrays = {};
  for (const sem of semantics) {
    weldedArrays[sem] = [];
  }
  const weldedNormals = [];
  const indices = [];
  const vertexHash = new Map();
  let nextVertexIndex = 0;

  for (let i = 0; i < vertexCount; i++) {
    let hash = "";

    // Hash normal
    const nx = normals[i * 3 + 0];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    hash += `${Math.round(nx * 1e4)}_${Math.round(ny * 1e4)}_${Math.round(nz * 1e4)}_`;

    const attrValues = {};
    for (let j = 0; j < semantics.length; j++) {
      const sem = semantics[j];
      const elementSize = attrElementSizes[j];
      const arr = attrArrays[j];
      const val = [];
      for (let c = 0; c < elementSize; c++) {
        const v = arr[i * elementSize + c];
        val.push(v);
        hash += `${Math.round(v * 1e4)}_`;
      }
      attrValues[sem] = val;
    }

    let idx = vertexHash.get(hash);
    if (idx === undefined) {
      idx = nextVertexIndex++;
      vertexHash.set(hash, idx);
      weldedNormals.push(nx, ny, nz);
      for (const sem of semantics) {
        const vals = attrValues[sem];
        for (let v = 0; v < vals.length; v++) {
          weldedArrays[sem].push(vals[v]);
        }
      }
    }
    indices.push(idx);
  }

  const buffer = document.getRoot().listBuffers()[0] || document.createBuffer();

  // Create normal accessor if it doesn't exist, otherwise replace
  let normalAccessor = primitive.getAttribute("NORMAL");
  if (!normalAccessor) {
    normalAccessor = document
      .createAccessor()
      .setType("VEC3")
      .setBuffer(buffer);
    primitive.setAttribute("NORMAL", normalAccessor);
  }
  normalAccessor.setArray(new Float32Array(weldedNormals));

  // Replace other accessors with welded data
  for (let j = 0; j < semantics.length; j++) {
    const sem = semantics[j];
    const oldAccessor = accessors[j];
    const newAccessor = document
      .createAccessor()
      .setType(oldAccessor.getType())
      .setBuffer(buffer);

    const ArrayType = oldAccessor.getArray().constructor;
    newAccessor.setArray(new ArrayType(weldedArrays[sem]));

    primitive.setAttribute(sem, newAccessor);
  }

  // Create/Replace index accessor
  const IndexArrayType = nextVertexIndex > 65535 ? Uint32Array : Uint16Array;
  const indexAccessor = document
    .createAccessor()
    .setType("SCALAR")
    .setBuffer(buffer)
    .setArray(new IndexArrayType(indices));

  primitive.setIndices(indexAccessor);
}

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
  const {
    wasmUrl,
    autoSmooth = false,
    creaseAngle = 30, // Default to 30 degrees
    binary = true,
    compression = false,
    resize,
  } = options;

  // We force a binary output whenever we need to perform extra transforms natively via `convertScadToGltf`
  const requireBinaryIntermediate =
    autoSmooth || compression || binary || resize !== undefined;

  if (!autoSmooth && !compression && resize === undefined) {
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

  if (autoSmooth) {
    // Removes indices + unrolls vertices ensuring fully disconnected faces first
    await document.transform(unweld());

    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        autoSmoothPrimitive(document, primitive, creaseAngle);
      }
    }

    // Discards detached accessors left over from unweld/reweld
    await document.transform(prune());
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
