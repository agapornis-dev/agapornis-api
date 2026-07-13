import * as fs from 'fs';
import * as path from 'path';

export function resolveProtoPath(fileName: string): string {
  const candidates = [
    process.env.AGAPORNIS_PROTO_DIR
      ? path.resolve(process.env.AGAPORNIS_PROTO_DIR, fileName)
      : '',
    path.resolve(process.cwd(), 'protos', fileName),
    path.resolve(__dirname, '..', '..', 'protos', fileName),
    path.resolve(__dirname, '..', 'protos', fileName)
  ].filter(Boolean);

  const match = candidates.find(candidate => fs.existsSync(candidate));
  return match || candidates[0] || path.resolve(process.cwd(), 'protos', fileName);
}
