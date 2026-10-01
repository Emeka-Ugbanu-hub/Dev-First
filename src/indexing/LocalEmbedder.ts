import * as path from 'path';

const MODEL_ID = 'all-MiniLM-L6-v2';

let pipelinePromise: Promise<any> | undefined;

export class LocalEmbedder {
  constructor(private readonly extensionPath: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.getPipeline();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    if (typeof output?.tolist === 'function') {
      return output.tolist() as number[][];
    }
    if (Array.isArray(output)) {
      return output as number[][];
    }
    throw new Error('Unexpected embedding output.');
  }

  private async getPipeline(): Promise<any> {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const transformers: any = await import('@huggingface/transformers');
        const { pipeline, env } = transformers;
        env.localModelPath = path.join(this.extensionPath, 'resources', 'models');
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
}
