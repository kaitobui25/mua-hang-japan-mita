import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

function reviewDirectory(): string {
  const configured = process.env.MITA_REVIEW_DIR;
  if (!configured) return path.join(process.cwd(), 'public', 'reviews');
  // An invalid setting must fail closed rather than quietly expose another folder.
  if (!path.isAbsolute(configured) || path.resolve(configured) === path.parse(configured).root) {
    throw new Error('MITA_REVIEW_DIR must be a non-root absolute directory');
  }
  return path.resolve(configured);
}
const MAX_IMAGES = 120;
const MAX_CANDIDATES = 300;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_ROUTE = '/anh-danh-gia';
// Keep a single safe filename, but allow ordinary spaces and Vietnamese characters.
const SAFE_IMAGE_NAME = /^(?![. ])[^<>:"/\\|?*\x00-\x1f\x7f]{1,180}\.(?:png|jpe?g|webp)$/i;
const DEMO_IMAGE_NAME = /^review-demo-\d+\.(?:png|jpe?g|webp)$/i;

export type ReviewImage = {
  file: string;
  src: string;
  isDemo: boolean;
};

export type ServedReviewImage = {
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
};

function contentTypeFor(filename: string): ServedReviewImage['contentType'] {
  const extension = path.extname(filename).toLowerCase();
  return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
}

function matchesImageSignature(buffer: Buffer, filename: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return extension === '.webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

async function withValidImage<T>(filename: string, use: (file: FileHandle, size: number) => Promise<T>): Promise<T | null> {
  if (!SAFE_IMAGE_NAME.test(filename)) return null;
  let file: FileHandle | undefined;
  try {
    const directory = reviewDirectory();
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
    const filepath = path.join(directory, filename);
    if (!(await lstat(filepath)).isFile()) return null;
    // O_NOFOLLOW prevents a symlink swap after lstat on Linux deployments.
    file = await open(filepath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_IMAGE_BYTES) return null;
    const signature = Buffer.alloc(12);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || !matchesImageSignature(signature, filename)) return null;
    return await use(file, stat.size);
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

async function isValidImage(filename: string): Promise<boolean> {
  return (await withValidImage(filename, async () => true)) === true;
}

/** Reads from the same validated handle; never follows the static public-file cache. */
export async function readReviewImage(filename: string): Promise<ServedReviewImage | null> {
  return withValidImage(filename, async (file, size) => {
    // Read an exact, bounded number of bytes from the validated file descriptor.
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await file.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) return null;
      offset += result.bytesRead;
    }
    if (!matchesImageSignature(bytes, filename)) return null;
    return { bytes, contentType: contentTypeFor(filename) };
  });
}

/**
 * Automatically publishes valid images placed in public/reviews on this server.
 * This verifies file safety, not customer consent or redaction. The owner must
 * approve/redact files before placing them in a publicly accessible folder.
 */
export async function loadReviewImages(): Promise<ReviewImage[]> {
  try {
    const directory = reviewDirectory();
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const filenames = entries
      .filter(entry => entry.isFile() && SAFE_IMAGE_NAME.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number(DEMO_IMAGE_NAME.test(a)) - Number(DEMO_IMAGE_NAME.test(b)) || a.localeCompare(b, 'vi', { numeric: true }))
      .slice(0, MAX_CANDIDATES);

    const images: ReviewImage[] = [];
    for (const file of filenames) {
      if (images.length >= MAX_IMAGES) break;
      if (!(await isValidImage(file))) continue;
      images.push({ file, src: `${IMAGE_ROUTE}/${encodeURIComponent(file)}`, isDemo: DEMO_IMAGE_NAME.test(file) });
    }
    return images;
  } catch {
    // Missing/inaccessible review folder: display the honest empty state.
    return [];
  }
}
