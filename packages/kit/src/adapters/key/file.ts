// The `file` key source: a 0600 file a person or a deploy step wrote. The file stays; only the handover copies the
// CLI writes into staging are deleted on reading.
import fs from 'node:fs';
import path from 'node:path';
import { isPrivateMode, secretFromFile } from '../../core/secret.ts';
import type { KeySource, KeySourceRef } from '../../types.ts';

export function fileKeySource(
  ref: Extract<KeySourceRef, { source: 'file' }>,
  platform: NodeJS.Platform = process.platform,
): KeySource {
  const file = path.resolve(ref.path);
  return {
    name: 'file',
    describe() {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat) return `file ${file} (missing)`;
      const mode = (stat.mode & 0o777).toString(8);
      const privacy =
        platform === 'win32'
          ? 'mode bits are advisory on Windows'
          : isPrivateMode(stat.mode, platform)
            ? 'private'
            : `mode ${mode}, must be 0600`;
      return `file ${file} (${privacy})`;
    },
    async read() {
      const key = secretFromFile(file, 'runner key', { deleteAfter: false, platform });
      if (!key) throw new Error(`no runner key: ${file} is missing or empty`);
      return key;
    },
  };
}
