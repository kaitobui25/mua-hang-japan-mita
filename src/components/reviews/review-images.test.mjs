import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadReviewImages, readReviewImage } from './review-images.ts';

const directory = path.join(process.cwd(), 'public', 'reviews');
const source = path.join(directory, 'review-demo-01.png');

test('new owner image automatically appears without editing a manifest', async () => {
  const name = `Ảnh phản hồi thử ${process.pid}.png`;
  const destination = path.join(directory, name);
  let copied = false;
  try {
    const before = await loadReviewImages();
    assert.ok(before.some(item => item.file === 'review-demo-01.png' && item.isDemo));
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    copied = true;
    const after = await loadReviewImages();
    const added = after.find(item => item.file === name);
    assert.deepEqual(added, { file: name, src: `/anh-danh-gia/${encodeURIComponent(name)}`, isDemo: false });
    assert.ok(!before.some(item => item.file === name));
    const served = await readReviewImage(name);
    assert.equal(served?.contentType, 'image/png');
    assert.ok(served?.bytes.equals((await readReviewImage('review-demo-01.png')).bytes));
  } finally {
    if (copied) await rm(destination);
  }
});

test('rejects misleading image extension and invalid signatures', async () => {
  const wrongSignature = path.join(directory, `owner-invalid-${process.pid}.png`);
  const wrongExtension = path.join(directory, `owner-invalid-${process.pid}.txt`);
  let wroteSignature = false;
  let copiedExtension = false;
  try {
    await writeFile(wrongSignature, Buffer.from('not really an image'), { flag: 'wx' });
    wroteSignature = true;
    await copyFile(source, wrongExtension, constants.COPYFILE_EXCL);
    copiedExtension = true;
    const images = await loadReviewImages();
    assert.ok(!images.some(item => [path.basename(wrongSignature), path.basename(wrongExtension)].includes(item.file)));
    assert.equal(await readReviewImage(path.basename(wrongSignature)), null);
    assert.equal(await readReviewImage(path.basename(wrongExtension)), null);
    assert.equal(await readReviewImage('../review-demo-01.png'), null);
    assert.equal(await readReviewImage('%2e%2e%2freview-demo-01.png'), null);
    assert.equal(await readReviewImage('review-demo-01.png/another.png'), null);
  } finally {
    if (wroteSignature) await rm(wrongSignature);
    if (copiedExtension) await rm(wrongExtension);
  }
});

test('does not publish symlinks', async t => {
  const linkedName = `owner-linked-${process.pid}.png`;
  const linkedPath = path.join(directory, linkedName);
  let linked = false;
  try {
    try {
      await symlink(source, linkedPath, 'file');
      linked = true;
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip('Creating symlinks is unavailable in this environment');
        return;
      }
      throw error;
    }
    assert.ok(!(await loadReviewImages()).some(item => item.file === linkedName));
    assert.equal(await readReviewImage(linkedName), null);
  } finally {
    if (linked) await rm(linkedPath);
  }
});

test('MITA_REVIEW_DIR loads persistent images outside the release folder', async () => {
  const shared = await mkdtemp(path.join(os.tmpdir(), 'mita-shared-reviews-'));
  const old = process.env.MITA_REVIEW_DIR;
  try {
    await copyFile(source, path.join(shared, 'Ảnh đã duyệt.png'));
    process.env.MITA_REVIEW_DIR = shared;
    const images = await loadReviewImages();
    assert.equal(images.length, 1);
    assert.equal(images[0].src, `/anh-danh-gia/${encodeURIComponent('Ảnh đã duyệt.png')}`);
    assert.equal((await readReviewImage('Ảnh đã duyệt.png')).contentType, 'image/png');
    assert.equal(await readReviewImage('review-demo-01.png'), null);
    process.env.MITA_REVIEW_DIR = 'reviews';
    assert.deepEqual(await loadReviewImages(), []);
    assert.equal(await readReviewImage('Ảnh đã duyệt.png'), null);
  } finally {
    if (old === undefined) delete process.env.MITA_REVIEW_DIR;
    else process.env.MITA_REVIEW_DIR = old;
    await rm(shared, { recursive: true, force: true });
  }
});
