import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';

type Pixels = { data: Uint8ClampedArray; width: number; height: number };

interface HeifImage {
  is_primary(): boolean;
  get_width(): number;
  get_height(): number;
  display(output: Pixels, callback: (result: Pixels | null) => void): void;
}

async function convert({
  bytes,
  maxPixels,
  previewEdge,
}: {
  bytes: Uint8Array;
  maxPixels: number;
  previewEdge: number;
}) {
  const entry = 'libheif-js/wasm-bundle.js';
  type DecoderModule = {
    HeifDecoder: new () => { decode(input: Uint8Array): HeifImage[] };
  };
  const { default: module } = (await import(entry)) as {
    default: DecoderModule | Promise<DecoderModule>;
  };
  const { HeifDecoder } = await module;
  const images = new HeifDecoder().decode(bytes);
  const image = images.find((candidate) => candidate.is_primary()) ?? images[0];
  if (!image) throw new Error('No decodable HEIC image was found');
  const width = image.get_width();
  const height = image.get_height();
  if (
    !Number.isSafeInteger(width * height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > maxPixels
  ) {
    throw new Error('HEIC dimensions exceed the pixel limit');
  }

  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data, width, height }, (result) => {
      if (result) resolve();
      else reject(new Error('HEVC pixel decoding failed'));
    });
  });
  // libheif applies orientation when decoding the primary image.
  return sharp(Buffer.from(data.buffer), {
    raw: { width, height, channels: 4 },
  })
    .resize(previewEdge, previewEdge, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

void convert(workerData as Parameters<typeof convert>[0])
  .then((preview) => {
    parentPort?.postMessage(preview);
  })
  .catch((error: unknown) => {
    // Report errors through the worker's error event.
    setImmediate(() => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  });
