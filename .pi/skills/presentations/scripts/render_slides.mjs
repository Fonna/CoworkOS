#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdtemp, mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

function usage() {
  console.log(
    "Usage: render_slides.mjs <deck.pptx|deck.pdf> [--output-dir DIR] [--pdf FILE] [--dpi N] [--columns N]"
  );
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.length === 0) return { help: true };
  const parsed = { input: argv[0], dpi: 150, columns: 3 };
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--output-dir" && value) ((parsed.outputDir = value), (i += 1));
    else if (argv[i] === "--pdf" && value) ((parsed.pdf = value), (i += 1));
    else if (argv[i] === "--dpi" && value) ((parsed.dpi = Number(value)), (i += 1));
    else if (argv[i] === "--columns" && value) ((parsed.columns = Number(value)), (i += 1));
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  if (!Number.isFinite(parsed.dpi) || parsed.dpi < 72 || parsed.dpi > 600)
    throw new Error("--dpi must be between 72 and 600");
  if (!Number.isInteger(parsed.columns) || parsed.columns < 1 || parsed.columns > 8)
    throw new Error("--columns must be between 1 and 8");
  return parsed;
}

export async function renderSlides(options, env = process.env) {
  options = { dpi: 150, columns: 3, ...options };
  if (
    !Number.isFinite(options.dpi) ||
    options.dpi < 72 ||
    options.dpi > 600 ||
    !Number.isInteger(options.columns) ||
    options.columns < 1 ||
    options.columns > 8
  )
    throw new Error("Invalid render DPI or column count");
  const input = resolve(options.input);
  const inputType = extname(input).toLowerCase();
  if (inputType !== ".pptx" && inputType !== ".pdf") throw new Error("input must be a .pptx or .pdf file");
  const stem = basename(input, extname(input));
  const outputDir = resolve(options.outputDir ?? join(dirname(input), `${stem}-preview`));
  await mkdir(outputDir, { recursive: true });
  const renderedPdf = join(outputDir, `${stem}.pdf`);
  const manifest = join(outputDir, "render-manifest.json");
  await rm(manifest, { force: true });
  const hash = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const inputHash = await hash(input);

  const profile = await mkdtemp(join(tmpdir(), "atria-libreoffice-"));
  await chmod(profile, 0o700);
  try {
    if (inputType === ".pptx") {
      await rm(renderedPdf, { force: true });
      const office = env.COWORK_SOFFICE_PATH ?? "soffice";
      await exec(
        office,
        [
          "--headless",
          "--nologo",
          "--nofirststartwizard",
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--convert-to",
          "pdf:impress_pdf_Export",
          "--outdir",
          outputDir,
          input
        ],
        {
          timeout: 120_000,
          maxBuffer: 1_000_000,
          env: {
            ...env,
            GSETTINGS_BACKEND: "memory",
            XDG_CONFIG_HOME: profile,
            XDG_CACHE_HOME: profile,
            XDG_RUNTIME_DIR: profile
          }
        }
      );
      try {
        await access(renderedPdf);
      } catch {
        throw new Error(`LibreOffice returned without producing ${renderedPdf}`);
      }
    } else if (input !== renderedPdf) {
      await copyFile(input, renderedPdf);
    }
    if (options.pdf) {
      const requestedPdf = resolve(options.pdf);
      if (requestedPdf === input && inputType === ".pptx")
        throw new Error("PDF output cannot overwrite the source presentation");
      await mkdir(dirname(requestedPdf), { recursive: true });
      if (requestedPdf !== renderedPdf) await copyFile(renderedPdf, requestedPdf);
    }

    for (const name of await readdir(outputDir)) {
      if (/^slide-\d+\.png$/i.test(name) || name === "contact-sheet.png")
        await rm(join(outputDir, name), { force: true });
    }
    const prefix = join(outputDir, "slide");
    const poppler = env.COWORK_PDFTOPPM_PATH ?? "pdftoppm";
    await exec(poppler, ["-png", "-r", String(options.dpi), renderedPdf, prefix], {
      timeout: 120_000,
      maxBuffer: 1_000_000
    });

    const slides = (await readdir(outputDir))
      .filter((name) => /^slide-\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
      .map((name) => join(outputDir, name));
    if (slides.length === 0) throw new Error("PDF rendered, but pdftoppm produced no slide images");

    const contactSheet = join(outputDir, "contact-sheet.png");
    await exec(poppler, ["-scale-to", "480", renderedPdf, join(profile, "thumb")], {
      timeout: 120_000,
      maxBuffer: 1_000_000
    });
    const thumbnails = (await readdir(profile))
      .filter((name) => /^thumb-\d+\.ppm$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((name) => join(profile, name));
    if (thumbnails.length !== slides.length)
      throw new Error("Thumbnail page count differs from rendered pages");
    await exec(
      env.COWORK_PYTHON_PATH ?? "python3",
      [
        fileURLToPath(new URL("./contact_sheet.py", import.meta.url)),
        "--output",
        contactSheet,
        "--columns",
        String(options.columns),
        ...thumbnails
      ],
      { timeout: 120_000, maxBuffer: 1_000_000 }
    );

    if ((await hash(input)) !== inputHash)
      throw new Error("Source changed during rendering; render the final source again");
    const evidence = {
      input,
      inputHash,
      renderedAt: new Date().toISOString(),
      pdf: renderedPdf,
      contactSheet,
      contactSheetHash: await hash(contactSheet),
      slides: await Promise.all(
        slides.map(async (path, index) => ({ page: index + 1, path, imageHash: await hash(path) }))
      )
    };
    await writeFile(manifest, JSON.stringify(evidence, null, 2) + "\n");
    return { input, outputDir, pdf: renderedPdf, contactSheet, slides, manifest };
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else console.log(JSON.stringify(await renderSlides(options), null, 2));
}
