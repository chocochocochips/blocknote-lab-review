import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync as rename, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export * from 'node:fs';

export function renameSync(source, target) {
  const localStaging = source.startsWith('/tmp/blocknote-site-') && dirname(source) === dirname(target);
  if (localStaging && lstatSync(source).isDirectory() && !existsSync(target)) {
    const entries = readdirSync(source, { withFileTypes: true });
    if (!entries.every(entry => entry.isFile())) throw new Error('Unexpected staging directory');
    mkdirSync(target);
    try {
      for (const entry of entries) copyFileSync(join(source, entry.name), join(target, entry.name));
    } catch (error) {
      rmSync(target, { recursive: true });
      throw error;
    }
    rmSync(source, { recursive: true });
    return;
  }
  try {
    rename(source, target);
  } catch (error) {
    // Workers VFS refuses to overwrite an existing file. These are private,
    // request-local staging files. The complete workspace is published by R2 CAS.
    if (error.code !== 'EEXIST' || !localStaging || !lstatSync(source).isFile() ||
        !lstatSync(target).isFile()) throw error;
    unlinkSync(target);
    rename(source, target);
  }
}
