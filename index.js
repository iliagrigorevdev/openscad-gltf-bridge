import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
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

  const cosAngle = Math.cos(creaseAngle);

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

function autoSmoothGeometry(geometry, creaseAngle) {
  const nonIndexed = geometry.index
    ? geometry.toNonIndexed()
    : geometry.clone();
  const positions = nonIndexed.attributes.position.array;

  const hasColor = nonIndexed.attributes.color !== undefined;
  const colors = hasColor ? nonIndexed.attributes.color.array : null;

  const hasSkinIndex = nonIndexed.attributes.skinIndex !== undefined;
  const skinIndices = hasSkinIndex
    ? nonIndexed.attributes.skinIndex.array
    : null;

  const hasSkinWeight = nonIndexed.attributes.skinWeight !== undefined;
  const skinWeights = hasSkinWeight
    ? nonIndexed.attributes.skinWeight.array
    : null;

  const normals = computeSmoothNormals(positions, creaseAngle);

  const weldedPositions = [];
  const weldedColors = [];
  const weldedNormals = [];
  const weldedSkinIndices = [];
  const weldedSkinWeights = [];
  const indices = [];
  const vertexHash = new Map();
  let nextVertexIndex = 0;

  for (let i = 0; i < positions.length / 3; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];

    let r = 0,
      g = 0,
      b = 0;
    if (hasColor) {
      r = colors[i * 3];
      g = colors[i * 3 + 1];
      b = colors[i * 3 + 2];
    }

    let si0 = 0,
      si1 = 0,
      si2 = 0,
      si3 = 0;
    if (hasSkinIndex) {
      si0 = skinIndices[i * 4];
      si1 = skinIndices[i * 4 + 1];
      si2 = skinIndices[i * 4 + 2];
      si3 = skinIndices[i * 4 + 3];
    }

    let sw0 = 0,
      sw1 = 0,
      sw2 = 0,
      sw3 = 0;
    if (hasSkinWeight) {
      sw0 = skinWeights[i * 4];
      sw1 = skinWeights[i * 4 + 1];
      sw2 = skinWeights[i * 4 + 2];
      sw3 = skinWeights[i * 4 + 3];
    }

    const hx = Math.round(px * 1e4);
    const hy = Math.round(py * 1e4);
    const hz = Math.round(pz * 1e4);
    const hnx = Math.round(nx * 1e4);
    const hny = Math.round(ny * 1e4);
    const hnz = Math.round(nz * 1e4);

    let hash = `${hx}_${hy}_${hz}_${hnx}_${hny}_${hnz}`;
    if (hasColor) {
      const hr = Math.round(r * 1e4);
      const hg = Math.round(g * 1e4);
      const hb = Math.round(b * 1e4);
      hash += `_${hr}_${hg}_${hb}`;
    }
    if (hasSkinIndex) {
      hash += `_${si0}_${si1}_${si2}_${si3}`;
    }
    if (hasSkinWeight) {
      const hw0 = Math.round(sw0 * 1e3);
      const hw1 = Math.round(sw1 * 1e3);
      const hw2 = Math.round(sw2 * 1e3);
      const hw3 = Math.round(sw3 * 1e3);
      hash += `_${hw0}_${hw1}_${hw2}_${hw3}`;
    }

    let idx = vertexHash.get(hash);
    if (idx === undefined) {
      idx = nextVertexIndex++;
      vertexHash.set(hash, idx);
      weldedPositions.push(px, py, pz);
      if (hasColor) weldedColors.push(r, g, b);
      weldedNormals.push(nx, ny, nz);
      if (hasSkinIndex) weldedSkinIndices.push(si0, si1, si2, si3);
      if (hasSkinWeight) weldedSkinWeights.push(sw0, sw1, sw2, sw3);
    }
    indices.push(idx);
  }

  const newGeometry = new THREE.BufferGeometry();
  newGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(weldedPositions, 3),
  );
  if (hasColor) {
    newGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(weldedColors, 3),
    );
  }
  newGeometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(weldedNormals, 3),
  );
  if (hasSkinIndex) {
    newGeometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute(weldedSkinIndices, 4),
    );
  }
  if (hasSkinWeight) {
    newGeometry.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute(weldedSkinWeights, 4),
    );
  }

  newGeometry.setIndex(indices);

  if (nonIndexed.groups && nonIndexed.groups.length > 0) {
    for (const g of nonIndexed.groups) {
      newGeometry.addGroup(g.start, g.count, g.materialIndex);
    }
  }

  nonIndexed.dispose();

  return newGeometry;
}

/**
 * Compiles SCAD to GLTF, applying caching, auto-smooth, and compression.
 * @param {string} scadCode - The raw SCAD input.
 * @param {Object} options - Configuration options.
 * @returns {Promise<Uint8Array | string>} Final GLTF data.
 */
export async function processScad(scadCode, options = {}) {
  const {
    wasmUrl,
    autoSmooth = false,
    creaseAngle = Math.PI / 6,
    binary = true,
  } = options;

  // 1. If NO auto-smooth, just let the original compiler do exactly what the user asked for.
  if (!autoSmooth) {
    return await convertScadToGltf(scadCode, { wasmUrl, binary });
  }

  // 2. Post-Process (Auto-Smooth) requires Three.js to parse the mesh.
  // We force WASM to give us a GLB (binary: true) here because it is self-contained
  // and easy for GLTFLoader to parse straight from memory.
  const rawGltfData = await convertScadToGltf(scadCode, {
    wasmUrl,
    binary: true,
  });

  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const arrayBuffer = rawGltfData.buffer.slice(
      rawGltfData.byteOffset,
      rawGltfData.byteOffset + rawGltfData.byteLength,
    );

    loader.parse(
      arrayBuffer,
      "",
      (gltf) => {
        const scene = gltf.scene;

        // Apply smoothing to all meshes
        scene.traverse((child) => {
          if (child.isMesh && child.geometry) {
            const oldGeom = child.geometry;
            child.geometry = autoSmoothGeometry(oldGeom, creaseAngle);
            oldGeom.dispose();

            if (child.material) {
              const makeSmooth = (m) => {
                m.flatShading = false;
                m.needsUpdate = true;
              };
              if (Array.isArray(child.material))
                child.material.forEach(makeSmooth);
              else makeSmooth(child.material);
            }
          }
        });

        // Export back to the requested format (GLTF JSON or GLB)
        const exporter = new GLTFExporter();
        const exportOptions = {
          binary: binary,
          animations: gltf.animations || [],
        };

        exporter.parse(
          scene,
          (processedData) => {
            // GLTFExporter returns an ArrayBuffer for binary, and a JSON object for text
            if (binary) {
              resolve(new Uint8Array(processedData));
            } else {
              resolve(JSON.stringify(processedData, null, 2));
            }
          },
          (error) => reject(error),
          exportOptions,
        );
      },
      reject,
    );
  });
}
