import {
  warmDecoders,
  decodeAeroflyAsset,
  encodeTocAsset,
  rgbaToPngBlob,
  isTocText,
  isTocJson,
  buildTocBinary,
} from "./decode.js";

const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const flipEl = document.getElementById("flip");
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
    setStatus("Ready — drop .ttx, .tsb, .toc, .toc.txt, or .json.", "ok");
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

function isAssetName(name) {
  return /\.(ttx|tsb|toc|json)$/i.test(name) || /\.toc\.txt$/i.test(name);
}

function baseName(fileName) {
  return (
    fileName
      .replace(/\.toc\.txt$/i, "")
      .replace(/\.(ttx|tsb|toc|json|txt)$/i, "") || "asset"
  );
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
  const hasTtx = fallback.some((f) => /\.ttx$/i.test(f.name));
  if (flipRow) flipRow.hidden = !hasTtx;

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

      // Text / JSON → encode uncompressed .toc
      if (isTocText(file.name, buf) || isTocJson(file.name, buf)) {
        const result = encodeTocAsset(buf, file.name);
        const ms = Math.round(performance.now() - t0);
        row.className = "result ok";
        metaSpan.textContent = [
          "encode → .toc",
          `${result.doc.placement_count} xrefs`,
          "uncompressed",
          `${ms} ms`,
        ].join(" · ");

        const blob = new Blob([result.binary], { type: "application/octet-stream" });
        const url = trackUrl(URL.createObjectURL(blob));
        actions.appendChild(downloadLink(url, `${base}.toc`, "Download .toc"));

        const pre = document.createElement("pre");
        pre.className = "result-text";
        pre.textContent = `${result.doc.placement_count} xref(s) packed · ${result.binary.length} bytes\n(shipping compress_file=true still needs the official converter)`;
        previewSlot.hidden = false;
        previewSlot.appendChild(pre);
        ok++;
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }

      const result = await decodeAeroflyAsset(buf, { flip: flipEl.checked });
      const ms = Math.round(performance.now() - t0);
      row.className = "result ok";

      if (result.kind === "toc") {
        metaSpan.textContent = [
          "cultivation",
          `${result.placement_count} xrefs`,
          result.compressed ? "compress_file" : "plain",
          `${ms} ms`,
        ].join(" · ");

        if (result.text) {
          const pre = document.createElement("pre");
          pre.className = "result-text";
          pre.textContent = result.text;
          previewSlot.hidden = false;
          previewSlot.appendChild(pre);

          const textUrl = trackUrl(
            URL.createObjectURL(new Blob([result.text], { type: "text/plain;charset=utf-8" }))
          );
          actions.appendChild(downloadLink(textUrl, `${base}.toc.txt`, "Download .toc.txt"));
        } else if (result.textError) {
          const pre = document.createElement("pre");
          pre.className = "result-text";
          pre.textContent = result.textError;
          previewSlot.hidden = false;
          previewSlot.appendChild(pre);
        }

        const jsonStr = JSON.stringify(result.doc, null, 2) + "\n";
        const jsonUrl = trackUrl(
          URL.createObjectURL(new Blob([jsonStr], { type: "application/json" }))
        );
        actions.appendChild(downloadLink(jsonUrl, `${base}.json`, "Download JSON"));

        // Re-encode from decoded doc (bit-exact for xref TOCs via JSON floats)
        if (result.doc.xref_list?.length) {
          try {
            const binary = buildTocBinary(result.doc);
            const binUrl = trackUrl(
              URL.createObjectURL(new Blob([binary], { type: "application/octet-stream" }))
            );
            actions.appendChild(
              downloadLink(binUrl, `${base}_uncompressed.toc`, "Download uncompressed .toc")
            );
          } catch (encErr) {
            console.warn("toc re-encode skipped", encErr);
          }
        }
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

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("drag");
});
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  const files = e.dataTransfer?.files;
  if (files?.length) handleFiles(files);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) handleFiles(fileInput.files);
});

boot();
