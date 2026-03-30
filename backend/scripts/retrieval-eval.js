#!/usr/bin/env node
/**
 * Retrieval evaluation: Recall@K, MRR, nDCG@K from a JSON / JSONL test set.
 *
 * Each example must include:
 *   - gold: [{ chunk_id, relevance }]  (relevance >= 1 counts as relevant)
 *   - ranked_chunk_ids: ordered list of chunk ids (system output, length >= K recommended)
 *
 * Usage:
 *   node scripts/retrieval-eval.js --input path/to/dataset.json [--out report.json] [--text-out report.txt] [--k 10] [--bootstrap 1000]
 *
 * Retrieve + eval in one step:
 *   node scripts/retrieval-eval-pipeline.js --input path/to/gold.json --collection-id <id> [--k 10]
 *
 * Or only fill ranked_chunk_ids:
 *   node scripts/run-retrieval-testset.js --input path/to/gold-only.json --collection-id <id> --out path/to/ranked.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_K = 10;
const DEFAULT_BOOTSTRAP = 1000;

function parseArgs(argv) {
  const out = { input: null, out: null, textOut: null, k: DEFAULT_K, bootstrap: DEFAULT_BOOTSTRAP };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--text-out' || a === '-t') out.textOut = argv[++i];
    else if (a === '--k') out.k = parseInt(argv[++i], 10);
    else if (a === '--bootstrap' || a === '-b') out.bootstrap = parseInt(argv[++i], 10);
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

/** Max relevance per chunk_id */
function buildGoldMap(gold) {
  const map = new Map();
  if (!Array.isArray(gold)) return map;
  for (const g of gold) {
    const id = g.chunk_id != null ? String(g.chunk_id) : g.chunkId != null ? String(g.chunkId) : null;
    if (!id) continue;
    const rel = Number(g.relevance);
    const r = Number.isFinite(rel) ? rel : 1;
    map.set(id, Math.max(map.get(id) || 0, r));
  }
  return map;
}

function sortedIdealGains(goldMap, k) {
  const gains = [...goldMap.values()].filter((r) => r > 0).sort((a, b) => b - a);
  return gains.slice(0, k);
}

function recallAtK(rankedIds, goldMap, k) {
  const top = rankedIds.slice(0, k);
  for (const id of top) {
    if ((goldMap.get(String(id)) || 0) >= 1) return 1;
  }
  return 0;
}

function mrrAtK(rankedIds, goldMap, k) {
  const top = rankedIds.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if ((goldMap.get(String(top[i])) || 0) >= 1) return 1 / (i + 1);
  }
  return 0;
}

function dcgAtK(rankedIds, goldMap, k) {
  const top = rankedIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const rel = goldMap.get(String(top[i])) || 0;
    dcg += rel / Math.log2(i + 2);
  }
  return dcg;
}

function idcgAtK(goldMap, k) {
  const gains = sortedIdealGains(goldMap, k);
  let idcg = 0;
  for (let i = 0; i < gains.length; i++) {
    idcg += gains[i] / Math.log2(i + 2);
  }
  return idcg;
}

function ndcgAtK(rankedIds, goldMap, k) {
  const dcg = dcgAtK(rankedIds, goldMap, k);
  const idcg = idcgAtK(goldMap, k);
  if (idcg <= 0) return 0;
  return dcg / idcg;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Bootstrap percentile CI for the mean (macro-average). */
function bootstrapMeanCI(values, iterations, seed) {
  const rng = mulberry32(seed);
  const n = values.length;
  if (n === 0) return { low: null, high: null, mean: 0 };
  const means = [];
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += values[Math.floor(rng() * n)];
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return {
    low: percentile(means, 0.025),
    high: percentile(means, 0.975),
    mean: mean(values)
  };
}

// Deterministic mulberry32
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evaluateExample(item, k, index) {
  const id = item.id != null ? String(item.id) : `row-${index}`;
  const query = item.query != null ? String(item.query) : '';
  const goldRaw = item.gold;
  const ranked = item.ranked_chunk_ids != null ? item.ranked_chunk_ids : item.rankedChunkIds;

  if (!Array.isArray(goldRaw) || goldRaw.length === 0) {
    throw new Error(`Example ${id}: missing or empty "gold"`);
  }
  if (!Array.isArray(ranked)) {
    throw new Error(
      `Example ${id}: missing "ranked_chunk_ids" (ordered chunk ids from retrieval)`
    );
  }

  const goldMap = buildGoldMap(goldRaw);
  const hasRelevant = [...goldMap.values()].some((r) => r >= 1);
  if (!hasRelevant) {
    throw new Error(`Example ${id}: at least one gold entry needs relevance >= 1`);
  }

  const recall = recallAtK(ranked, goldMap, k);
  const mrr = mrrAtK(ranked, goldMap, k);
  const ndcg = ndcgAtK(ranked, goldMap, k);

  return {
    id,
    query,
    metrics: {
      [`recall@${k}`]: recall,
      [`mrr@${k}`]: mrr,
      [`ndcg@${k}`]: ndcg
    },
    ranked_length: ranked.length
  };
}

function summarize(values, name, bootstrapIterations, bootstrapSeed) {
  const sorted = [...values].sort((a, b) => a - b);
  const ci = bootstrapMeanCI(values, bootstrapIterations, bootstrapSeed);
  const failZero = values.filter((v) => v === 0).length;
  return {
    metric: name,
    n: values.length,
    mean: ci.mean,
    failure_rate: values.length ? failZero / values.length : 0,
    failure_count: failZero,
    /** Failure = metric value exactly 0 (no hit in top-K for recall/mrr-style). */
    percentiles: {
      p10: percentile(sorted, 0.1),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.9),
      min: sorted[0],
      max: sorted[sorted.length - 1]
    },
    ci95_mean_bootstrap: {
      low: ci.low,
      high: ci.high,
      iterations: bootstrapIterations,
      seed: bootstrapSeed
    }
  };
}

function pctLine(s) {
  const p = s.percentiles;
  return `  percentiles: min=${p.min?.toFixed(4)}  p10=${p.p10?.toFixed(4)}  p25=${p.p25?.toFixed(4)}  p50=${p.p50?.toFixed(4)}  p75=${p.p75?.toFixed(4)}  p90=${p.p90?.toFixed(4)}  max=${p.max?.toFixed(4)}`;
}

function ciLine(s) {
  const c = s.ci95_mean_bootstrap;
  return `  ci95(mean) bootstrap: [${c.low?.toFixed(6)}, ${c.high?.toFixed(6)}]`;
}

/**
 * Run evaluation on in-memory items (each must have gold + ranked_chunk_ids).
 * @returns {{ report: object, finalText: string, failedRecallIds: string[] }}
 */
function buildEvalReport(items, k, bootstrapIterations, inputPath) {
  const perExample = [];
  const recalls = [];
  const mrrs = [];
  const ndcgs = [];

  for (let i = 0; i < items.length; i++) {
    const row = evaluateExample(items[i], k, i);
    perExample.push(row);
    recalls.push(row.metrics[`recall@${k}`]);
    mrrs.push(row.metrics[`mrr@${k}`]);
    ndcgs.push(row.metrics[`ndcg@${k}`]);
  }

  const failedRecallIds = perExample
    .filter((r) => r.metrics[`recall@${k}`] === 0)
    .map((r) => r.id);

  const report = {
    generated_at: new Date().toISOString(),
    input: inputPath,
    k,
    n_examples: items.length,
    schema: {
      gold: '{ chunk_id, relevance } relevance >= 1 counts as relevant',
      ranked_chunk_ids: 'ordered ids from retrieval (first = rank 1)'
    },
    per_example: perExample,
    summary: {
      [`recall@${k}`]: summarize(recalls, `recall@${k}`, bootstrapIterations, 0x243f6a88),
      [`mrr@${k}`]: summarize(mrrs, `mrr@${k}`, bootstrapIterations, 0x243f6a89),
      [`ndcg@${k}`]: summarize(ndcgs, `ndcg@${k}`, bootstrapIterations, 0x243f6a8a)
    },
    failed_recall_at_k: failedRecallIds,
    failed_recall_note: `No gold chunk with relevance>=1 in top-${k} (same as recall@${k}===0).`
  };

  const textOut = [
    `Retrieval eval report`,
    `  input: ${inputPath}`,
    `  examples: ${items.length}  K=${k}  bootstrap=${bootstrapIterations}`,
    ''
  ];
  for (const key of [`recall@${k}`, `mrr@${k}`, `ndcg@${k}`]) {
    const s = report.summary[key];
    textOut.push(`${key}:`);
    textOut.push(`  mean: ${s.mean.toFixed(6)}  failure_rate: ${(s.failure_rate * 100).toFixed(2)}% (${s.failure_count}/${s.n})`);
    textOut.push(pctLine(s));
    textOut.push(ciLine(s));
    textOut.push('');
  }

  if (failedRecallIds.length) {
    textOut.push(`Failed queries (recall@${k} = 0, no relevant chunk in top-${k}):`);
    for (const fid of failedRecallIds) {
      textOut.push(`  - ${fid}`);
    }
    textOut.push('');
  } else {
    textOut.push(`Failed queries (recall@${k} = 0): (none)`);
    textOut.push('');
  }

  const finalText = textOut.join('\n');
  return { report, finalText, failedRecallIds };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.error(`Usage: node scripts/retrieval-eval.js --input <dataset.json|jsonl> [--out report.json] [--text-out report.txt] [--k 10] [--bootstrap 1000]

Dataset format:
  - JSON array of examples, or JSON object with "items" array, or JSONL (one JSON per line).
  - Each example:
      "id": optional string
      "query": optional string (for logs)
      "gold": [ { "chunk_id": "...", "relevance": 3 }, ... ]   (relevance >= 1 = relevant)
      "ranked_chunk_ids": [ "chunk-a", "chunk-b", ... ]        (system retrieval order)

Notes:
  - Metrics are macro-averaged over examples.
  - Failure rate = fraction of examples where the metric equals 0.
  - CI95 uses bootstrap on the per-example values (mean).

One-shot retrieve + eval:
  node scripts/retrieval-eval-pipeline.js --input <gold.json> --collection-id <id> [--k 10]
`);
    process.exit(args.help ? 0 : 1);
  }

  const k = Number.isFinite(args.k) && args.k > 0 ? args.k : DEFAULT_K;
  const bootstrapIterations =
    Number.isFinite(args.bootstrap) && args.bootstrap > 0 ? args.bootstrap : DEFAULT_BOOTSTRAP;
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

  let result;
  try {
    result = buildEvalReport(items, k, bootstrapIterations, inputPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const { report, finalText } = result;
  console.log(finalText);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.error(`Wrote JSON report: ${outPath}`);
  }
  if (args.textOut) {
    const textPath = path.resolve(args.textOut);
    fs.writeFileSync(textPath, finalText + '\n', 'utf8');
    console.error(`Wrote text report: ${textPath}`);
  }
}

module.exports = {
  DEFAULT_K,
  DEFAULT_BOOTSTRAP,
  loadDataset,
  evaluateExample,
  summarize,
  buildEvalReport,
  buildGoldMap,
  recallAtK,
  mrrAtK,
  ndcgAtK
};

if (require.main === module) {
  main();
}
