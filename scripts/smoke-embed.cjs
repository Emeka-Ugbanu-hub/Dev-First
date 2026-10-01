// Loads the bundled all-MiniLM-L6-v2 model and verifies that related sentences
// score higher than unrelated ones. Run with: npm run smoke:embed
const path = require('path');

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

(async () => {
  const transformers = await import('@huggingface/transformers');
  const { pipeline, env } = transformers;
  env.localModelPath = path.join(__dirname, '..', 'resources', 'models');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  console.log('Loading all-MiniLM-L6-v2 from resources/models…');
  const extractor = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', {
    dtype: 'fp32',
    device: 'cpu',
  });

  const texts = [
    'how do I reset a user password',
    'password reset flow for users',
    'the cat sat on the mat',
  ];
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const vectors = output.tolist();

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`Unexpected embedding output shape: ${JSON.stringify(vectors)?.slice(0, 120)}`);
  }
  if (vectors[0].length !== 384) {
    throw new Error(`Expected 384 dimensions, got ${vectors[0].length}`);
  }

  const related = cosine(vectors[0], vectors[1]);
  const unrelated = cosine(vectors[0], vectors[2]);
  console.log(`dims=${vectors[0].length} related=${related.toFixed(3)} unrelated=${unrelated.toFixed(3)}`);

  if (related <= unrelated) {
    throw new Error('Sanity check failed: related sentences should score higher than unrelated ones.');
  }
  console.log('embedding smoke OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
