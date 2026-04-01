#!/usr/bin/env node
/**
 * One-shot: run production retrieval for each query, then score (Recall@K, MRR@K, nDCG@K).
 * Same retrieval path as POST /api/kb/retrieval/debug (kbService.retrievalDebug).
 *
 * Usage:
 *   node testing/retrieval/retrieval-eval-pipeline.js --input testing/retrieval/eval-datasets/kb_chunk_testset_10.json \
 *     --collection-id <id> [--k 10] [--out report.json] [--text-out report.txt] \
 *     [--out-ranked path.json]
 *
 * --out-ranked   Save ranked dataset (default: <input>.ranked.json). Use --no-out-ranked to skip.
 *
 * Requires backend .env (ES, Qdrant, DB as needed for kbService).
 */

const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { DEFAULT_RETRIEVAL_TOP_K } = require('../../src/config/retrievalConstants');
const { retrievalDebug } = require('../../src/services/kbService');
const { loadDataset, buildEvalReport, DEFAULT_K, DEFAULT_BOOTSTRAP } = require('./retrieval-eval');

function parseArgs(argv) {
  const out = {
    input: null,
    collectionId: null,
    outRanked: null,
    saveRanked: true,
    out: null,
    textOut: null,
    k: DEFAULT_K,
    bootstrap: DEFAULT_BOOTSTRAP,
    esTopK: DEFAULT_RETRIEVAL_TOP_K,
    vecTopK: DEFAULT_RETRIEVAL_TOP_K,
    fuseTopK: DEFAULT_RETRIEVAL_TOP_K,
    rankSource: 'reranked'
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--collection-id' || a === '-c') out.collectionId = argv[++i];
    else if (a === '--out-ranked') out.outRanked = argv[++i];
    else if (a === '--no-out-ranked') out.saveRanked = false;
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--text-out' || a === '-t') out.textOut = argv[++i];
    else if (a === '--k') out.k = parseInt(argv[++i], 10);
    else if (a === '--bootstrap' || a === '-b') out.bootstrap = parseInt(argv[++i], 10);
    else if (a === '--es-top-k') out.esTopK = parseInt(argv[++i], 10);
    else if (a === '--vec-top-k') out.vecTopK = parseInt(argv[++i], 10);
    else if (a === '--fuse-top-k') out.fuseTopK = parseInt(argv[++i], 10);
    else if (a === '--rank-source') out.rankSource = String(argv[++i] || '').toLowerCase();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function chunkIdsFromHits(hits) {
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => String(h.chunkId != null ? h.chunkId : h.chunk_id || '')).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.error(`Usage: node testing/retrieval/retrieval-eval-pipeline.js --input <dataset.json> --collection-id <n> [options]

  --out-ranked <path>   Write ranked JSON (default: <input>.ranked.json)
  --no-out-ranked       Do not write ranked JSON
  --out <path>          Write full eval JSON report
  --text-out <path>     Write eval text report
  --k <n>               Eval cutoff (default ${DEFAULT_K})
  --bootstrap <n>       Bootstrap iterations (default ${DEFAULT_BOOTSTRAP})
  --es-top-k / --vec-top-k / --fuse-top-k   Retrieval depth (defaults from retrievalConstants)
  --rank-source         reranked | fused   (default reranked)
`);
    process.exit(args.help ? 0 : 1);
  }

  const collectionId = Number(args.collectionId);
  if (!Number.isFinite(collectionId) || collectionId <= 0) {
    console.error('Missing or invalid --collection-id (positive number required).');
    process.exit(1);
  }

  const k = Number.isFinite(args.k) && args.k > 0 ? args.k : DEFAULT_K;
  const bootstrap =
    Number.isFinite(args.bootstrap) && args.bootstrap > 0 ? args.bootstrap : DEFAULT_BOOTSTRAP;
  const esTopK = Number.isFinite(args.esTopK) && args.esTopK > 0 ? args.esTopK : DEFAULT_RETRIEVAL_TOP_K;
  const vecTopK = Number.isFinite(args.vecTopK) && args.vecTopK > 0 ? args.vecTopK : DEFAULT_RETRIEVAL_TOP_K;
  const fuseTopK = Number.isFinite(args.fuseTopK) && args.fuseTopK > 0 ? args.fuseTopK : DEFAULT_RETRIEVAL_TOP_K;
  const rankSource = args.rankSource === 'fused' ? 'fused' : 'reranked';

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  let items;
  try {
    items = loadDataset(inputPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const rankedItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item.id != null ? String(item.id) : `row-${i}`;
    const query = item.query != null ? String(item.query) : '';
    if (!query.trim()) {
      console.error(`Example ${id}: empty query.`);
      process.exit(1);
    }

    process.stderr.write(`[retrieve ${i + 1}/${items.length}] ${id} … `);
    const result = await retrievalDebug({
      collectionId,
      query,
      esTopK,
      vecTopK,
      fuseTopK
    });
    const hits = rankSource === 'fused' ? result.fused : result.reranked;
    const ranked_chunk_ids = chunkIdsFromHits(hits);
    process.stderr.write(`${ranked_chunk_ids.length} ids\n`);

    const row = { ...item };
    delete row.ranked_chunk_ids;
    delete row.rankedChunkIds;
    delete row.retrieval_meta;
    rankedItems.push({
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

  if (args.saveRanked) {
    const rankedPath = args.outRanked
      ? path.resolve(args.outRanked)
      : inputPath.replace(/\.json$/i, '') + '.ranked.json';
    fs.writeFileSync(rankedPath, JSON.stringify(rankedItems, null, 2), 'utf8');
    process.stderr.write(`Wrote ranked dataset: ${rankedPath}\n`);
  }

  const pipelineNote = `${inputPath} (pipeline: retrieved in-process, K=${k})`;
  let evalResult;
  try {
    evalResult = buildEvalReport(rankedItems, k, bootstrap, pipelineNote);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const { report, finalText, failedRecallIds } = evalResult;
  const rankedSavedPath = args.saveRanked
    ? path.resolve(args.outRanked || inputPath.replace(/\.json$/i, '') + '.ranked.json')
    : null;
  report.pipeline = {
    source_input: inputPath,
    collection_id: collectionId,
    rank_source: rankSource,
    esTopK,
    vecTopK,
    fuseTopK,
    ranked_saved: rankedSavedPath
  };

  console.log(finalText);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    process.stderr.write(`Wrote JSON report: ${outPath}\n`);
  }
  if (args.textOut) {
    const textPath = path.resolve(args.textOut);
    fs.writeFileSync(textPath, finalText + '\n', 'utf8');
    process.stderr.write(`Wrote text report: ${textPath}\n`);
  }

  if (failedRecallIds.length) {
    process.stderr.write(`\nFailed query ids (recall@${k}=0): ${failedRecallIds.join(', ')}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
