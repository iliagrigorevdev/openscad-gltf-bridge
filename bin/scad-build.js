#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import { processScad } from "../index.js";

// 1. Safely resolve the WASM file path using Node's module resolution
const require = createRequire(import.meta.url);
const wasmPath = require.resolve("openscad-gltf-wasm/openscad.wasm");

// 2. Polyfill fetch so the WASM loader works natively in Node.js
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

async function run() {
  // Parse simple CLI arguments for flags and config names
  const args = process.argv.slice(2);
  const forceRebuild = args.includes("--force");
  const configFileName =
    args.find((a) => !a.startsWith("--")) || "scad.config.js";

  // 3. Find the config file in the user's project root
  const configPath = path.resolve(process.cwd(), configFileName);

  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.log(`Please create a scad.config.js file in your project root.`);
    process.exit(1);
  }

  // Get the modification time of the configuration file itself
  const configStat = fs.statSync(configPath);

  // 4. Import the user's config
  const configModule = await import(pathToFileURL(configPath).href);
  const config = configModule.default || configModule;

  const outDir = path.resolve(process.cwd(), config.outDir || "./public");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(`⚙️  Starting OpenSCAD to GLTF build...`);

  // 5. Process each asset
  for (const asset of config.assets) {
    const inputPath = path.resolve(process.cwd(), asset.input);

    // Auto-generate output filename if not provided
    const isBinary =
      asset.options?.binary !== false || asset.options?.compression;
    const defaultExt = isBinary ? ".glb" : ".gltf";
    const outputName =
      asset.output ||
      path.basename(asset.input, path.extname(asset.input)) + defaultExt;
    const outputPath = path.resolve(outDir, outputName);

    if (!fs.existsSync(inputPath)) {
      console.warn(`⚠️  Input file missing, skipping: ${inputPath}`);
      continue;
    }

    // --- OPTIMIZATION LOGIC ---
    // Skip building if output exists, unless forced
    if (!forceRebuild && fs.existsSync(outputPath)) {
      const inputStat = fs.statSync(inputPath);
      const outputStat = fs.statSync(outputPath);

      // If output file is newer than BOTH the input .scad file and the config file, skip
      if (
        outputStat.mtimeMs >= inputStat.mtimeMs &&
        outputStat.mtimeMs >= configStat.mtimeMs
      ) {
        console.log(`⏩ Skipping ${path.basename(asset.input)} (up-to-date)`);
        continue;
      }
    }

    console.log(`Processing ${path.basename(asset.input)}...`);
    const scadCode = fs.readFileSync(inputPath, "utf8");

    try {
      const glbData = await processScad(scadCode, {
        wasmUrl: `file://${wasmPath}`,
        binary: true,
        ...asset.options, // Extensible options like autoSmooth, creaseAngle, compression, resize
      });

      fs.writeFileSync(outputPath, glbData);
      console.log(`✅ Saved -> ${path.relative(process.cwd(), outputPath)}`);
    } catch (error) {
      console.error(`❌ Failed to process ${asset.input}:`, error);
    }
  }
}

run();
