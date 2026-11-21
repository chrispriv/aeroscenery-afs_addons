import { warmDecoders, decodeAeroflyAsset, decodeTtx, rgbaToPngBlob } from "./decode.js";
import { encodeRgbaToTtx, imageFileToRgba } from "./encode_ttx.js";
import { wavToTsb, pcmToWavBlob } from "./tsb.js";

const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const flipEl = document.getElementById("flip");
const encodeFormatEl = document.getElementById("encodeFormat");
const flipRow = document.getElementById("flipRow");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

let ready = false;
/** @type {string[]} */
let objectUrls = [];
let busy = false;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function revokeAll() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function trackUrl(url) {
  objectUrls.push(url);
  return url;
}

function downloadLink(url, filename, label) {
  const a = document.createElement("a");
  a.className = "btn btn-sm";
  a.href = url;
  a.download = filename;
  a.textContent = label;
  return a;
}

async function boot() {
  try {
    await warmDecoders();
    ready = true;
    setStatus("Ready — drop .ttx, .tsb, .png, .jpg, or .wav.", "ok");
  } catch (e) {
    console.error(e);
    setStatus(`Failed to load decoder: ${e.message || e}`, "err");
  }
}

function addResultRow(fileName) {
  const li = document.createElement("li");
  li.className = "result pending";
  li.innerHTML = `
    <div class="result-preview-slot" hidden></div>
    <div class="result-body">
      <div class="result-main">
        <span class="result-name"></span>
        <span class="result-meta">queued…</span>
      </div>
      <div class="result-actions"></div>
    </div>
  `;
  li.querySelector(".result-name").textContent = fileName;
  resultsEl.appendChild(li);
  resultsEl.hidden = false;
  return li;
}

function isImageName(name) {
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function isWavName(name) {
  return /\.wav$/i.test(name);
}

function isAssetName(name) {
  return isImageName(name) || isWavName(name) || /\.(ttx|tsb)$/i.test(name);
}

function baseName(fileName) {
  return fileName.replace(/\.(png|jpe?g|webp|wav|ttx|tsb)$/i, "") || "asset";
}

function ttxDownloadName(base, format) {
  const tag =
    {
      type_rgb_etc2: "etc2",
      type_rgba_etc2: "etc2a",
      type_rgb_s3tc_dxt1: "dxt1",
      type_rgba_s3tc_dxt5: "dxt5",
    }[format] || "ttx";
  return `${base}_${tag}.ttx`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @param {File[]} files
 */
async function handleFiles(files) {
  if (!ready) {
    setStatus("Decoder still loading…");
    return;
  }
  if (busy) {
    setStatus("Already converting — wait for the current batch.", "err");
    return;
  }
  const list = [...files];
  const batch = list.filter((f) => isAssetName(f.name));
  const fallback = batch.length ? batch : list;
  if (!fallback.length) {
    setStatus("No supported files selected.", "err");
    return;
  }

  busy = true;
  revokeAll();
  resultsEl.innerHTML = "";
  resultsEl.hidden = false;

  let ok = 0;
  let fail = 0;
  const hasFlip = fallback.some((f) => /\.(ttx|png|jpe?g|webp)$/i.test(f.name));
  if (flipRow) flipRow.hidden = !hasFlip;

  for (let i = 0; i < fallback.length; i++) {
    const file = fallback[i];
    const row = addResultRow(file.name);
    const metaSpan = row.querySelector(".result-meta");
    const actions = row.querySelector(".result-actions");
    const previewSlot = row.querySelector(".result-preview-slot");
    setStatus(`Processing ${i + 1}/${fallback.length}: ${file.name}…`);

    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const t0 = performance.now();
      const base = baseName(file.name);

      if (isImageName(file.name)) {
        const family = encodeFormatEl && encodeFormatEl.value === "dxt" ? "dxt" : "etc2";
        const image = await imageFileToRgba(file);
        const encoded = await encodeRgbaToTtx(image.rgba, image.width, image.height, {
          family,
          flip: flipEl.checked,
          onStatus: (msg) => {
            metaSpan.textContent = msg;
          },
        });
        const ms = Math.round(performance.now() - t0);
        row.className = "result ok";
        const parts = [
          `${encoded.width}×${encoded.height}`,
          encoded.format,
          `${encoded.mips} mips`,
          "plain",
          formatBytes(encoded.bytes.length),
          `${ms} ms`,
          flipEl.checked ? "flipped" : "no flip",
        ];
        if (encoded.warning) parts.push(encoded.warning);
        metaSpan.textContent = parts.join(" · ");

        const ttxUrl = trackUrl(
          URL.createObjectURL(new Blob([encoded.bytes], { type: "application/octet-stream" }))
        );
        const outName = ttxDownloadName(base, encoded.format);
        row.querySelector(".result-name").textContent = `${file.name} → ${outName}`;
        actions.appendChild(downloadLink(ttxUrl, outName, "Download .ttx"));

        try {
          const preview = await decodeTtx(encoded.bytes, { flip: flipEl.checked });
          const png = await rgbaToPngBlob(preview.rgba, preview.width, preview.height);
          const pngUrl = trackUrl(URL.createObjectURL(png));
          const img = document.createElement("img");
          img.className = "result-preview";
          img.src = pngUrl;
          img.alt = `${base} encoded preview`;
          previewSlot.hidden = false;
          previewSlot.appendChild(img);
        } catch (previewErr) {
          console.warn("encode preview skipped", previewErr);
        }

        ok++;
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }

      if (isWavName(file.name)) {
        const encoded = await wavToTsb(buf);
        const ms = Math.round(performance.now() - t0);
        row.className = "result ok";
        const outName = `${base}.tsb`;
        row.querySelector(".result-name").textContent = `${file.name} → ${outName}`;
        const duration = encoded.frames / encoded.sampleRate;
        metaSpan.textContent = [
          encoded.format,
          `${encoded.sampleRate} Hz`,
          `${encoded.bits}-bit`,
          "mono",
          `${duration.toFixed(2)} s`,
          "compress_file",
          formatBytes(encoded.bytes.length),
          `${ms} ms`,
        ].join(" · ");

        const tsbUrl = trackUrl(
          URL.createObjectURL(new Blob([encoded.bytes], { type: "application/octet-stream" }))
        );
        actions.appendChild(downloadLink(tsbUrl, outName, "Download .tsb"));

        const wavUrl = trackUrl(URL.createObjectURL(pcmToWavBlob(encoded.pcm, encoded.sampleRate, 1, 16)));
        const audio = document.createElement("audio");
        audio.className = "result-audio";
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = wavUrl;
        previewSlot.hidden = false;
        previewSlot.appendChild(audio);

        ok++;
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }

      const result = await decodeAeroflyAsset(buf, { flip: flipEl.checked });
      const ms = Math.round(performance.now() - t0);
      row.className = "result ok";

      if (result.kind === "toc") {
        throw new Error("Scenery tables (.toc and similar) are not converted in this tool.");
      } else if (result.kind === "sound") {
        const url = trackUrl(URL.createObjectURL(result.wavBlob));
        metaSpan.textContent = [
          result.format,
          `${Math.round(result.sampleRate)} Hz`,
          `${result.bits}-bit`,
          result.channels === 1 ? "mono" : `${result.channels}ch`,
          `${result.durationSec.toFixed(2)} s`,
          result.compressed ? "compress_file" : "plain",
          `${ms} ms`,
        ].join(" · ");

        const audio = document.createElement("audio");
        audio.className = "result-audio";
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = url;
        previewSlot.hidden = false;
        previewSlot.appendChild(audio);

        actions.appendChild(downloadLink(url, `${base}.wav`, "Download WAV"));
      } else {
        const blob = await rgbaToPngBlob(result.rgba, result.width, result.height);
        const url = trackUrl(URL.createObjectURL(blob));
        metaSpan.textContent = [
          `${result.width}×${result.height}`,
          result.format,
          result.compressed ? "compress_file" : "plain",
          `${ms} ms`,
          flipEl.checked ? "flipped" : "no flip",
        ].join(" · ");

        const img = document.createElement("img");
        img.className = "result-preview";
        img.src = url;
        img.alt = `${base} preview`;
        previewSlot.hidden = false;
        previewSlot.appendChild(img);

        actions.appendChild(downloadLink(url, `${base}.png`, "Download PNG"));
      }

      ok++;
    } catch (e) {
      console.error(file.name, e);
      row.className = "result err";
      metaSpan.textContent = e.message || String(e);
      fail++;
    }

    await new Promise((r) => setTimeout(r, 0));
  }

  busy = false;
  fileInput.value = "";
  if (flipRow) flipRow.hidden = false;
  if (fail === 0) {
    setStatus(`Done — ${ok} file${ok === 1 ? "" : "s"} converted.`, "ok");
  } else {
    setStatus(
      `Done — ${ok} ok, ${fail} failed.`,
      fail === fallback.length ? "err" : "ok"
    );
  }
}

function isFileDrag(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

// Capture phase runs before the file input. A second drop of the same
// path does not fire "change", and the input can clear dataTransfer.files
// before a bubble listener reads them.
document.addEventListener(
  "dragover",
  (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    drop.classList.add("drag");
  },
  true
);
document.addEventListener(
  "dragleave",
  (e) => {
    if (!e.relatedTarget) drop.classList.remove("drag");
  },
  true
);
document.addEventListener(
  "drop",
  (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("drag");
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) handleFiles(files);
  },
  true
);
fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files || [])];
  fileInput.value = "";
  if (files.length) handleFiles(files);
});

boot();
