import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmbedWorkerClient } from '../src/indexing/EmbedWorkerClient';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-embed-client-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('EmbedWorkerClient', () => {
  it('contains worker crashes and trips the circuit breaker', async () => {
    const worker = path.join(root, 'crash-worker.cjs');
    await fs.writeFile(worker, 'process.on("message", () => process.exit(5));\n', 'utf-8');
    const client = new EmbedWorkerClient(worker, root);

    await expect(client.embed(['one'])).rejects.toThrow(/exited/);
    await expect(client.embed(['two'])).rejects.toThrow(/repeated embedding-worker crashes/);
    await expect(client.embed(['three'])).rejects.toThrow(/repeated embedding-worker crashes/);
    client.stop();
  });
});
