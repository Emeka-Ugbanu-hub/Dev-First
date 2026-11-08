import * as path from 'path';

interface EmbedMessage {
  type?: string;
  id?: string;
  texts?: unknown;
}

const MODEL_ID = 'all-MiniLM-L6-v2';
let pipelinePromise: Promise<any> | undefined;
let modelRoot = process.env.DEVFIRST_MODEL_ROOT || process.argv[2] || '';

function send(message: Record<string, unknown>): void {
  try {
    process.send?.(message);
  } catch {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const transformers: any = await import('@huggingface/transformers');
      const { pipeline, env } = transformers;
      env.localModelPath = modelRoot || path.join(__dirname, '..', 'resources', 'models');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      return pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32', device: 'cpu' });
    })().catch((error) => {
      pipelinePromise = undefined;
      throw error;
    });
  }
  return pipelinePromise;
}

async function embed(texts: string[]): Promise<number[][]> {
  const extractor = await getPipeline();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  if (typeof output?.tolist === 'function') {
    return output.tolist() as number[][];
  }
  if (Array.isArray(output)) {
    return output as number[][];
  }
  throw new Error('Unexpected embedding output.');
}

process.on('message', (message: EmbedMessage) => {
  if (!message || message.type !== 'embed' || typeof message.id !== 'string' || !Array.isArray(message.texts)) {
    return;
  }
  const texts = message.texts.filter((text): text is string => typeof text === 'string');
  void embed(texts)
    .then((vectors) => send({ type: 'result', id: message.id, vectors }))
    .catch((error) => send({ type: 'error', id: message.id, message: errorMessage(error) }));
});

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (error) => {
  send({ type: 'fatal', message: errorMessage(error) });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  send({ type: 'fatal', message: errorMessage(error) });
  process.exit(1);
});
