#!/usr/bin/env node
import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const port = args.includes("--port")
  ? parseInt(args[args.indexOf("--port") + 1]) || 3000
  : 3000;
const configFileName =
  args.find((a) => !a.startsWith("--")) || "scad.config.json";
const configPath = path.resolve(process.cwd(), configFileName);

const app = express();
app.use(express.json());

// Basic CORS middleware for external web clients
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, PUT, POST, PATCH, DELETE, OPTIONS",
  );
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function readConfig() {
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      console.error("Error parsing config:", e);
    }
  }
  // Default structure if missing
  return { inputDir: "./assets", outDir: "./public/models", assets: [] };
}

function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function buildModel(input) {
  return new Promise((resolve, reject) => {
    const buildScript = path.join(__dirname, "scad-build.js");
    console.log(`\n[API-Build] Triggering build for: ${input}`);

    const child = spawn(
      process.execPath,
      [buildScript, configFileName, "--force", "--filter", input],
      { stdio: "pipe" },
    );

    let stderr = "";
    // Echo output to server console in real-time
    child.stdout.pipe(process.stdout);
    child.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on("error", (err) => {
      console.error(`[API-Build Error] Failed to start build process: ${err}`);
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[API-Build] Build successful for: ${input}`);
        resolve();
      } else {
        const errorMsg = `Build process for ${input} exited with code ${code}. Stderr: ${stderr.trim()}`;
        console.error(`[API-Build Error] ${errorMsg}`);
        reject(new Error(errorMsg));
      }
    });
  });
}

// ========================
// 1. Config Endpoints
// ========================

app.get("/api/config", (req, res) => {
  res.json(readConfig());
});

app.post("/api/config", (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.assets)) {
    return res
      .status(400)
      .json({ error: "Invalid config format. 'assets' array required." });
  }
  writeConfig(config);
  res.json({ message: "Config saved", config });
});

// ========================
// 2. Model Management
// ========================

// Get SCAD model content
app.get("/api/models", (req, res) => {
  const input = req.query.input;
  if (!input) {
    return res.status(400).json({ error: "Missing 'input' query parameter." });
  }

  const config = readConfig();
  const inputDir = path.resolve(process.cwd(), config.inputDir || "./");
  const filePath = path.resolve(inputDir, `${input}.scad`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Model file not found on server." });
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: "Failed to read model file." });
  }
});

// Add/Update SCAD model in filesystem and config
app.post("/api/models", (req, res) => {
  const { input, output, options, content } = req.body;
  if (!input) {
    return res.status(400).json({ error: "Missing 'input' name." });
  }

  const config = readConfig();
  const inputDir = path.resolve(process.cwd(), config.inputDir || "./");

  // Write model file to filesystem (upsert)
  if (content !== undefined) {
    const filePath = path.resolve(inputDir, `${input}.scad`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf-8");
  }

  // Update config
  const existingIndex = config.assets.findIndex((a) => a.input === input);

  const newAsset = { input };
  if (output) newAsset.output = output;
  if (options) newAsset.options = options;

  if (existingIndex >= 0) {
    config.assets[existingIndex] = newAsset;
  } else {
    config.assets.push(newAsset);
  }

  writeConfig(config);
  res.json({ message: "Model created/updated successfully", asset: newAsset });
});

// Update specific model's config parameters only
app.patch("/api/models", (req, res) => {
  const { input, output, options } = req.body;
  if (!input) {
    return res
      .status(400)
      .json({ error: "Missing 'input' name to identify the model." });
  }

  const config = readConfig();
  const asset = config.assets.find((a) => a.input === input);
  if (!asset) {
    return res.status(404).json({ error: "Model not found in config." });
  }

  if (output !== undefined) {
    if (output === "") delete asset.output;
    else asset.output = output;
  }
  if (options !== undefined) {
    asset.options = { ...(asset.options || {}), ...options };
  }

  writeConfig(config);
  res.json({ message: "Model configuration updated", asset });
});

// Build a single model and return the file
app.post("/api/models/build", async (req, res) => {
  const { input } = req.body;
  if (!input) {
    return res.status(400).json({ error: "Missing 'input' name." });
  }

  const config = readConfig();
  const asset = config.assets.find((a) => a.input === input);
  if (!asset) {
    return res.status(404).json({ error: "Model not found in config." });
  }

  try {
    await buildModel(input);

    // Determine output path (logic from scad-build.js)
    const outDir = path.resolve(process.cwd(), config.outDir || "./public");
    const isBinary =
      asset.options?.binary !== false || asset.options?.compression;
    const defaultExt = isBinary ? ".glb" : ".gltf";
    const outputName = asset.output
      ? `${asset.output}${defaultExt}`
      : `${asset.input}${defaultExt}`;
    const outputPath = path.resolve(outDir, outputName);

    if (!fs.existsSync(outputPath)) {
      console.error(`Build output file not found at: ${outputPath}`);
      return res
        .status(500)
        .json({ error: "Build succeeded but output file was not found." });
    }

    res.sendFile(outputPath, (err) => {
      if (err) {
        console.error("Error sending file:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to send the built file." });
        }
      }
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Build process failed.", details: err.message });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 scad-serve listening on port ${port}`);
  console.log(`📁 Managing configuration file: ${configPath}`);
});
