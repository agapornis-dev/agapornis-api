const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const artifactPath = required('RELEASE_ARTIFACT');
const repository = required('GITHUB_REPOSITORY');
const tag = required('GITHUB_REF_NAME');
const file = path.basename(artifactPath);
const body = fs.readFileSync(artifactPath);
const manifest = {
  schemaVersion: 1,
  component: 'api',
  version: tag.replace(/^v/, ''),
  channel: 'stable',
  publishedAt: new Date().toISOString(),
  releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
  artifact: {
    url: `https://github.com/${repository}/releases/download/${tag}/${file}`,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    sizeBytes: body.length,
  },
};

fs.writeFileSync(required('RELEASE_MANIFEST'), `${JSON.stringify(manifest, null, 2)}\n`);
