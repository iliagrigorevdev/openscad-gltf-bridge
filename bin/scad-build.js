#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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

  let filterString = null;
  let configFileName = "scad.config.json";

  const positionalArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force") {
      continue;
    } else if (args[i] === "--filter") {
      if (i + 1 < args.length) {
        filterString = args[++i];
      }
      continue;
    } else if (!args[i].startsWith("--")) {
      positionalArgs.push(args[i]);
    }
  }

  if (positionalArgs.length > 0) {
    configFileName = positionalArgs[0];
  }

  // 3. Find the config file in the user's project root
  const configPath = path.resolve(process.cwd(), configFileName);

  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.log(`Please create a scad.config.json file in your project root.`);
    process.exit(1);
  }

  // Get the modification time of the configuration file itself
  const configStat = fs.statSync(configPath);

  // 4. Parse the user's config
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const inputDir = path.resolve(process.cwd(), config.inputDir || "./");
  const outDir = path.resolve(process.cwd(), config.outDir || "./public");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(`⚙️  Starting OpenSCAD to GLTF build...`);

  // 5. Process each asset
  for (const asset of config.assets) {
    if (filterString) {
      const query = filterString.toLowerCase();
      const inMatch = asset.input && asset.input.toLowerCase().includes(query);
      const outMatch =
        asset.output && asset.output.toLowerCase().includes(query);

      if (!inMatch && !outMatch) {
        continue;
      }
    }

    const inputPath = path.resolve(inputDir, `${asset.input}.scad`);

    // Auto-generate output filename if not provided
    const isBinary =
      asset.options?.binary !== false || asset.options?.compression;
    const defaultExt = isBinary ? ".glb" : ".gltf";
    const outputName = asset.output
      ? `${asset.output}${defaultExt}`
      : `${asset.input}${defaultExt}`;
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
        console.log(`⏩ Skipping ${asset.input} (up-to-date)`);
        continue;
      }
    }

    console.log(`Processing ${asset.input}...`);
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
