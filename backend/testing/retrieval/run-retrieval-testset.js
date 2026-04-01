#!/usr/bin/env node
/**
 * Fill ranked_chunk_ids using the same code path as production debug retrieval:
 * kbService.retrievalDebug → createHybridRetrievalService → retrievalService.retrievalDebug
 * (same as POST /api/kb/retrieval/debug in kbController.retrievalDebugItem).
 *
 * Usage:
 *   node testing/retrieval/run-retrieval-testset.js --input testing/retrieval/eval-datasets/kb_chunk_testset_10.json \
 *     --collection-id <id> --out testing/retrieval/eval-datasets/kb_chunk_testset_10.ranked.json
 *
 * Or use one-shot pipeline (retrieve + metrics + failed ids):
 *   node testing/retrieval/retrieval-eval-pipeline.js --input <same> --collection-id <id> --k 10
 *
 * Then (rank-only workflow):
 *   node testing/retrieval/retrieval-eval.js --input testing/retrieval/eval-datasets/kb_chunk_testset_10.ranked.json --k 10
 *
 * Defaults match kbController / retrievalConstants (esTopK, vecTopK, fuseTopK). If retrieval-eval uses --k 10,
 * pass e.g. --fuse-top-k 10 --es-top-k 10 --vec-top-k 10 so the ranked list is long enough.
 *
 * Requires backend .env (ES, Qdrant, DB as needed for kbService) like running the API.
 */

const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { DEFAULT_RETRIEVAL_TOP_K } = require('../../src/config/retrievalConstants');
const { retrievalDebug } = require('../../src/services/kbService');

function parseArgs(argv) {
  const out = {
    input: null,
    out: null,
    collectionId: null,
    esTopK: DEFAULT_RETRIEVAL_TOP_K,
    vecTopK: DEFAULT_RETRIEVAL_TOP_K,
    fuseTopK: DEFAULT_RETRIEVAL_TOP_K,
    rankSource: 'reranked'
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--collection-id' || a === '-c') out.collectionId = argv[++i];
    else if (a === '--es-top-k') out.esTopK = parseInt(argv[++i], 10);
    else if (a === '--vec-top-k') out.vecTopK = parseInt(argv[++i], 10);
    else if (a === '--fuse-top-k') out.fuseTopK = parseInt(argv[++i], 10);
    else if (a === '--rank-source') out.rankSource = String(argv[++i] || '').toLowerCase();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadDataset(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jsonl') {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    return lines.map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`JSONL parse error at line ${idx + 1}: ${e.message}`);
      }
    });
  }
  const trimmed = raw.trim();
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  throw new Error('JSON root must be an array or an object with an "items" array');
}

function chunkIdsFromHits(hits) {
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => String(h.chunkId != null ? h.chunkId : h.chunk_id || '')).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.error(`Usage: node testing/retrieval/run-retrieval-testset.js --input <dataset.json> --collection-id <n> [--out <path>]

  --out            Output JSON (default: <input>.ranked.json next to input)
  --es-top-k       Default from retrievalConstants (same as API)
  --vec-top-k      Default from retrievalConstants
  --fuse-top-k     Default from retrievalConstants
  --rank-source    reranked | fused   (default reranked; final order after hybrid fuse + rerank)
`);
    process.exit(args.help ? 0 : 1);
  }

  const collectionId = Number(args.collectionId);
  if (!Number.isFinite(collectionId) || collectionId <= 0) {
    console.error('Missing or invalid --collection-id (positive number required).');
    process.exit(1);
  }

  const esTopK = Number.isFinite(args.esTopK) && args.esTopK > 0 ? args.esTopK : DEFAULT_RETRIEVAL_TOP_K;
  const vecTopK = Number.isFinite(args.vecTopK) && args.vecTopK > 0 ? args.vecTopK : DEFAULT_RETRIEVAL_TOP_K;
  const fuseTopK = Number.isFinite(args.fuseTopK) && args.fuseTopK > 0 ? args.fuseTopK : DEFAULT_RETRIEVAL_TOP_K;
  const rankSource = args.rankSource === 'fused' ? 'fused' : 'reranked';

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const outPath = args.out
    ? path.resolve(args.out)
    : inputPath.replace(/\.json$/i, '') + '.ranked.json';

  let items;
  try {
    items = loadDataset(inputPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const output = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item.id != null ? String(item.id) : `row-${i}`;
    const query = item.query != null ? String(item.query) : '';
    if (!query.trim()) {
      console.error(`Example ${id}: empty query, skipping.`);
      process.exit(1);
    }

    process.stderr.write(`[${i + 1}/${items.length}] ${id} … `);
    const result = await retrievalDebug({
      collectionId,
      query,
      esTopK,
      vecTopK,
      fuseTopK
    });
    const hits = rankSource === 'fused' ? result.fused : result.reranked;
    const ranked_chunk_ids = chunkIdsFromHits(hits);
    process.stderr.write(`${ranked_chunk_ids.length} ids (${rankSource})\n`);

    const row = { ...item };
    delete row.ranked_chunk_ids;
    delete row.rankedChunkIds;
    output.push({
      ...row,
      ranked_chunk_ids,
      retrieval_meta: {
        rank_source: rankSource,
        esTopK,
        vecTopK,
        fuseTopK,
        collectionId,
        timingMs: result.timingMs || null
      }
    });
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.error(`Wrote ${output.length} examples → ${outPath}`);
  console.error(`Run: node testing/retrieval/retrieval-eval.js --input ${path.relative(process.cwd(), outPath)} --k <K<=fuseTopK>`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
