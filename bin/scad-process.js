#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { processScad } from "../index.js";

// 1. Safely resolve the WASM file path
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
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPath = args[1];
  const optionsJson = args[2];

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: scad-process <input.scad> <output.glb> [options_json]",
    );
    process.exit(1);
  }

  let options = {};
  if (optionsJson) {
    if (optionsJson.startsWith("{")) {
      // If it starts with '{', try parsing as normal JSON
      options = JSON.parse(optionsJson);
    } else {
      // Otherwise, safely decode the Base64 string
      const decoded = Buffer.from(optionsJson, "base64").toString("utf8");
      options = JSON.parse(decoded);
    }
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const scadCode = fs.readFileSync(inputPath, "utf8");

  try {
    const glbData = await processScad(scadCode, {
      wasmUrl: `file://${wasmPath}`,
      ...options,
    });

    fs.writeFileSync(outputPath, glbData);
    process.exit(0);
  } catch (error) {
    console.error("SCAD Conversion Error:", error);
    process.exit(1);
  }
}

run();
