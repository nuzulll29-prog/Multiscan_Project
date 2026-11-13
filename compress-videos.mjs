// Mengompres video asli (HDR10+/HDR10/HLG, HEVC 10-bit, atau resolusi besar) di R2 menjadi SDR H.264 + AAC, sisi terpanjang maks 854 px.
// Video yang sudah berbentuk hasil kompresi Cloudinary (H.264 8-bit, <= 854 px) dibiarkan, jadi aman dijalankan berulang.
// Dijalankan oleh .github/workflows/compress.yml, env: ORDER_ID, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

const MAX_SIDE = 854;
// sisi terpanjang maksimal 854 px (sama seperti kompresi Cloudinary), tidak diperbesar
const SCALE = `scale='if(gt(iw,ih),min(${MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_SIDE},ih))'`;
// HDR -> SDR: ke cahaya linear, tone-map, lalu BT.709
const TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
const OUT_ARGS = [
  "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-pix_fmt", "yuv420p",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
];

function probe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height,color_transfer,color_primaries,color_space:stream_side_data=side_data_type",
    "-of", "json", file]).toString();
  const s = (JSON.parse(out).streams || [])[0] || {};
  const side = (s.side_data_list || []).map((d) => d.side_data_type || "").join(",");
  return { codec: s.codec_name || "?", pix: s.pix_fmt || "?", w: s.width || 0, h: s.height || 0,
    trc: s.color_transfer || "-", prim: s.color_primaries || "-", side };
}

// HDR sungguhan: transfer PQ/HLG, atau warna BT.2020, atau ada data HDR10+/Dolby Vision
const isHdr = (i) => i.trc === "smpte2084" || i.trc === "arib-std-b67" || i.prim === "bt2020" || /HDR|DOVI|Dolby|Mastering|Content light/i.test(i.side);
// hasil kompresi Cloudinary: H.264 8-bit dan tidak lebih besar dari 854 px
const isCompressed = (i) => i.codec === "h264" && !/10/.test(i.pix) && Math.max(i.w, i.h) <= MAX_SIDE + 2;

function convert(src, dst, hdr) {
  const run = (vf) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", vf, ...OUT_ARGS, dst], { stdio: "inherit" });
  if (hdr) {
    try { return run(`${SCALE},${TONEMAP}`); }
    catch (e) { console.log("  tone-mapping gagal, memakai konversi sederhana…"); }
  }
  run(`${SCALE},format=yuv420p`);
}

const describe = (i) => `${i.codec} ${i.pix} ${i.w}x${i.h} trc=${i.trc} prim=${i.prim}${i.side ? " side=" + i.side : ""}`;

// Mode uji lokal: LOCAL_TEST=1 node compress-videos.mjs in.mp4 [in2.mp4 ...]  (hasil: out-<nama>)
if (process.env.LOCAL_TEST) {
  for (const f of process.argv.slice(2)) {
    const i = probe(f);
    const need = !isCompressed(i);
    console.log(`${f}: ${describe(i)} -> ${need ? (isHdr(i) ? "KOMPRES (HDR)" : "KOMPRES (SDR)") : "dilewati"}`);
    if (need) convert(f, "out-" + f.split("/").pop(), isHdr(i));
  }
  process.exit(0);
}

const { ORDER_ID, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!/^[A-Za-z0-9_-]{1,40}$/.test(ORDER_ID || "")) throw new Error("ORDER_ID tidak valid");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const dir = join(process.env.RUNNER_TEMP || "/tmp", "vid-" + ORDER_ID);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const prefix = `orders/${ORDER_ID}/videos/`;
const list = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix }));
const keys = (list.Contents || []).map((o) => o.Key).filter((k) => k.toLowerCase().endsWith(".mp4"));
console.log(`Order ${ORDER_ID}: ${keys.length} video`);

let done = 0, failed = 0;
for (const key of keys) {
  const name = key.slice(prefix.length);
  const src = join(dir, "in-" + name), dst = join(dir, "out-" + name);
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    await pipeline(obj.Body, createWriteStream(src));
    const info = probe(src), before = statSync(src).size;
    console.log(`${name}: ${(before / 1048576).toFixed(1)} MB, ${describe(info)}`);
    if (isCompressed(info)) { console.log(`  sudah terkompres, dilewati`); continue; }
    console.log(`  ${isHdr(info) ? "HDR" : "SDR besar"}, mengompres…`);
    convert(src, dst, isHdr(info));
    const after = statSync(dst).size;
    if (after < 1024) throw new Error("hasil kompresi kosong");
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: createReadStream(dst), ContentLength: after, ContentType: "video/mp4" }));
    console.log(`  ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB, tersimpan`);
    done++;
  } catch (e) {
    failed++;
    console.error(`${name}: GAGAL - ${e.message}`);
  } finally {
    rmSync(src, { force: true }); rmSync(dst, { force: true });
  }
}
console.log(`Selesai: ${done} dikompres, ${failed} gagal`);
if (failed) process.exit(1);
