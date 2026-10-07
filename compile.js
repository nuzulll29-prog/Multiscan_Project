// Compile foto dari R2 -> targets.mind -> upload balik ke R2
// Struktur R2 (sesuaikan PHOTOS_PREFIX / OUTPUT_KEY kalau struktur kamu beda):
//   orders/<ORDER_ID>/photos/01.jpg ... 12.jpg   (input)
//   orders/<ORDER_ID>/mind/targets.mind          (output)
//   orders/<ORDER_ID>/videos/01.mp4 ... 12.mp4   (tidak perlu dikompilasi)

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { loadImage } from "canvas";
import { OfflineCompiler } from "mind-ar/src/image-target/offline-compiler.js";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  ORDER_ID,
} = process.env;

for (const [k, v] of Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  ORDER_ID,
})) {
  if (!v) throw new Error(`Env ${k} belum diisi`);
}

const PHOTOS_PREFIX = `orders/${ORDER_ID}/photos/`;
const OUTPUT_KEY = `orders/${ORDER_ID}/mind/targets.mind`;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function listPhotoKeys() {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: PHOTOS_PREFIX })
  );
  return (res.Contents || [])
    .map((o) => o.Key)
    .filter((k) => /\.(jpe?g|png|webp)$/i.test(k))
    .sort(); // urutan nama file = index target (01 -> 0, 02 -> 1, ...)
}

async function download(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function main() {
  const keys = await listPhotoKeys();
  if (keys.length === 0) throw new Error(`Tidak ada foto di ${PHOTOS_PREFIX}`);
  console.log(`Ditemukan ${keys.length} foto:`);
  keys.forEach((k, i) => console.log(`  target ${i} <- ${k}`));

  const images = [];
  for (const key of keys) {
    const buf = await download(key);
    images.push(await loadImage(buf));
  }

  const compiler = new OfflineCompiler();
  await compiler.compileImageTargets(images, (p) =>
    console.log(`Kompilasi: ${p.toFixed(1)}%`)
  );

  const mind = Buffer.from(compiler.exportData());
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: OUTPUT_KEY,
      Body: mind,
      ContentType: "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  console.log(`Selesai: ${OUTPUT_KEY} (${(mind.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
