// Mengompres video HDR (HDR10+/HDR10/HLG) di R2 menjadi SDR 480p H.264 + AAC.
// Video yang sudah SDR (sudah dikompres Cloudinary) dibiarkan, jadi aman dijalankan berulang.
// Dijalankan oleh .github/workflows/compress.yml, env: ORDER_ID, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

const { ORDER_ID, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!/^[A-Za-z0-9_-]{1,40}$/.test(ORDER_ID || "")) throw new Error("ORDER_ID tidak valid");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

// sisi terpanjang maksimal 854 px (sama seperti kompresi Cloudinary), tidak diperbesar
const SCALE = "scale='if(gt(iw,ih),min(854,iw),-2)':'if(gt(iw,ih),-2,min(854,ih))'";
// HDR -> SDR: ke cahaya linear, tone-map, lalu BT.709
const TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
const OUT_ARGS = [
  "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-pix_fmt", "yuv420p",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
];

function isHdr(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer", "-of", "csv=p=0", file]).toString().trim();
  return out === "smpte2084" || out === "arib-std-b67";
}

function convert(src, dst) {
  const run = (vf) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", vf, ...OUT_ARGS, dst], { stdio: "inherit" });
  try { run(`${SCALE},${TONEMAP}`); }
  catch (e) {
    console.log("  tone-mapping gagal, memakai konversi sederhana…");
    run(`${SCALE},format=yuv420p`);
  }
}

const dir = join(process.env.RUNNER_TEMP || "/tmp", "hdr-" + ORDER_ID);
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
    if (!isHdr(src)) { console.log(`${name}: SDR, dilewati`); continue; }
    const before = statSync(src).size;
    console.log(`${name}: HDR (${(before / 1048576).toFixed(1)} MB), mengompres…`);
    convert(src, dst);
    const after = statSync(dst).size;
    if (after < 1024) throw new Error("hasil kompresi kosong");
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: createReadStream(dst), ContentLength: after, ContentType: "video/mp4" }));
    console.log(`${name}: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB, tersimpan`);
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
