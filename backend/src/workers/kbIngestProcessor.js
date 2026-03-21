const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { runIngestPipeline, normalizeFileExt } = require('../services/kbService');
const { KbFile, KbJob } = require('../models');
const { publishKbTaskStatus } = require('../services/wsEventPublisher');
const { isS3Uri, getObjectBufferByUri } = require('../services/objectStorageService');

let mammoth = null;
try {
  // Optional runtime dependency for docx parsing.
  mammoth = require('mammoth');
} catch (error) {
  mammoth = null;
}

let xlsx = null;
try {
  xlsx = require('xlsx');
} catch (error) {
  xlsx = null;
}

let PDFParse = null;
try {
  const pdfParseModule = require('pdf-parse');
  PDFParse = pdfParseModule.PDFParse
    || pdfParseModule.default?.PDFParse
    || pdfParseModule.default
    || null;
} catch (error) {
  PDFParse = null;
}

let pdfjsLib = null;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
} catch (error) {
  pdfjsLib = null;
}

function normalizeNoiseKey(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyDocxNoise(text = '') {
  const value = String(text || '').trim();
  if (!value) return true;
  const compact = value.replace(/\s+/g, '');
  if (/^(目录|目\s*录|table\s+of\s+contents)$/i.test(value)) return true;
  if (/^第?\s*\d+\s*页(\s*\/\s*共?\s*\d+\s*页)?$/i.test(compact)) return true;
  if (/^page\s*\d+(\s*of\s*\d+)?$/i.test(value)) return true;
  if (/^[-_]{3,}$/.test(value)) return true;
  // Typical TOC line with dotted leader and page number.
  if (/^.+[.\u2026·•]{3,}\s*\d+\s*$/.test(value)) return true;
  return false;
}

function isLikelyPdfNoise(text = '') {
  const value = String(text || '').trim();
  if (!value) return true;
  const compact = value.replace(/\s+/g, '');
  if (/^(目录|目\s*录|table\s+of\s+contents)$/i.test(value)) return true;
  if (/^第?\s*\d+\s*页(\s*\/\s*共?\s*\d+\s*页)?$/i.test(compact)) return true;
  if (/^page\s*\d+(\s*of\s*\d+)?$/i.test(value)) return true;
  if (/^[\-_=]{3,}$/.test(value)) return true;
  // Typical TOC line with dotted leader and page number.
  if (/^.+[.\u2026·•]{3,}\s*\d+\s*$/.test(value)) return true;
  return false;
}

function cleanPdfPageLines(pageText = '') {
  return String(pageText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function extractPdfTextWithNoiseFiltering(rawText = '') {
  const pages = String(rawText || '')
    .split('\f')
    .map((page) => cleanPdfPageLines(page));
  if (!pages.length) return '';

  const headerFooterFreq = new Map();
  pages.forEach((lines) => {
    const headCandidates = lines.slice(0, 2);
    const tailCandidates = lines.slice(Math.max(0, lines.length - 2));
    [...headCandidates, ...tailCandidates].forEach((line) => {
      const key = normalizeNoiseKey(line);
      if (!key || key.length > 80) return;
      headerFooterFreq.set(key, (headerFooterFreq.get(key) || 0) + 1);
    });
  });
  const repeatedHeaderFooterKeys = new Set(
    Array.from(headerFooterFreq.entries())
      .filter(([, count]) => count >= 2)
      .map(([key]) => key)
  );

  const cleanedPages = pages.map((lines) => lines
    .filter((line) => !isLikelyPdfNoise(line))
    .filter((line) => !repeatedHeaderFooterKeys.has(normalizeNoiseKey(line))));

  return cleanedPages
    .filter((lines) => lines.length)
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

function splitPdfTableCells(line = '') {
  const raw = String(line || '').trim();
  if (!raw) return [];
  const byPipe = raw.split('|').map((item) => item.trim()).filter(Boolean);
  if (byPipe.length >= 3) return byPipe;
  const byGap = raw.split(/\s{2,}|\t+/).map((item) => item.trim()).filter(Boolean);
  if (byGap.length >= 3) return byGap;
  return [];
}

function buildPdfRowKvText(headerCells = [], rowCells = []) {
  const maxLength = Math.max(headerCells.length, rowCells.length);
  const pieces = [];
  for (let index = 0; index < maxLength; index += 1) {
    const header = String(headerCells[index] || `列${index + 1}`).trim();
    const value = String(rowCells[index] || '').trim();
    if (!value) continue;
    pieces.push(`${header}: ${value}`);
  }
  return pieces.join('; ');
}

async function parsePdfToStructured(absPath) {
  if (!pdfjsLib) return null;
  const OPS = pdfjsLib.OPS || {};
  const loadingTask = pdfjsLib.getDocument({ url: absPath });
  const pdf = await loadingTask.promise;
  const blocks = [];
  const assets = [];
  let tableCounter = 0;
  let imageCounter = 0;

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const textContent = await page.getTextContent();
    const lineMap = new Map();
    (textContent.items || []).forEach((item) => {
      const y = Number(item?.transform?.[5] || 0);
      const key = String(Math.round(y));
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key).push({
        x: Number(item?.transform?.[4] || 0),
        text: String(item?.str || '').trim()
      });
    });
    const lines = Array.from(lineMap.values())
      .map((items) => items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim())
      .filter(Boolean)
      .filter((line) => !isLikelyPdfNoise(line));

    if (lines.length) {
      blocks.push({
        type: 'heading',
        level: 1,
        text: `PDF 第${pageNo}页`
      });
    }

    for (let index = 0; index < lines.length; index += 1) {
      const current = lines[index];
      const headerCells = splitPdfTableCells(current);
      const nextCells = splitPdfTableCells(lines[index + 1] || '');
      const hasTableStart = headerCells.length >= 3 && nextCells.length >= 3;
      if (!hasTableStart) {
        blocks.push({ type: 'paragraph', text: current });
        continue;
      }

      tableCounter += 1;
      const tableId = `pdf-page-${pageNo}-table-${tableCounter}`;
      const tableRows = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const rowCells = splitPdfTableCells(lines[cursor]);
        if (rowCells.length < 2) break;
        tableRows.push(rowCells);
        cursor += 1;
      }
      if (!tableRows.length) {
        blocks.push({ type: 'paragraph', text: current });
        continue;
      }
      const tableAssetKey = `${tableId}.csv`;
      const csvLines = [headerCells, ...tableRows]
        .map((cells) => cells.map((cell) => `"${String(cell || '').replace(/"/g, '""')}"`).join(','))
        .join('\n');
      assets.push({
        assetKey: tableAssetKey,
        assetType: 'table',
        contentType: 'text/csv',
        text: csvLines,
        sourcePageNo: pageNo,
        sourceRef: tableId,
        meta: {
          parser: 'pdfjs',
          tableId
        }
      });
      blocks.push({
        type: 'image',
        imageKey: tableAssetKey
      });
      blocks.push({
        type: 'table_summary',
        text: `表头: ${headerCells.join(' | ')}`,
        tableId,
        rowIndex: 0
      });
      tableRows.forEach((rowCells, rowIndex) => {
        const rowKvText = buildPdfRowKvText(headerCells, rowCells);
        if (!rowKvText) return;
        blocks.push({
          type: 'table_row',
          text: rowKvText,
          rowKvText,
          tableId,
          rowIndex: rowIndex + 1
        });
      });
      index = cursor - 1;
    }

    const opList = await page.getOperatorList();
    const imageOps = (opList.fnArray || []).reduce((count, fn) => {
      if (
        fn === OPS.paintImageXObject
        || fn === OPS.paintInlineImageXObject
        || fn === OPS.paintImageXObjectRepeat
      ) {
        return count + 1;
      }
      return count;
    }, 0);
    for (let imgNo = 0; imgNo < imageOps; imgNo += 1) {
      imageCounter += 1;
      const imageKey = `pdf-page-${pageNo}-image-${imgNo + 1}.json`;
      const payload = JSON.stringify({
        pageNo,
        imageNo: imgNo + 1,
        extractedBy: 'pdfjs-operator-list'
      });
      assets.push({
        assetKey: imageKey,
        assetType: 'image',
        contentType: 'application/json',
        text: payload,
        sourcePageNo: pageNo,
        sourceRef: `pdf-page-${pageNo}-image-${imgNo + 1}`,
        meta: {
          parser: 'pdfjs',
          representation: 'operator_image_marker'
        }
      });
      blocks.push({
        type: 'image',
        imageKey
      });
    }
  }

  const textOnlyBlocks = blocks
    .filter((item) => item.type !== 'image')
    .map((item) => String(item.text || '').trim())
    .filter(Boolean);
  return {
    rawText: textOnlyBlocks.join('\n\n'),
    pdf: {
      blocks,
      assets
    }
  };
}

function decodeHtmlText(value = '') {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value = '') {
  return decodeHtmlText(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function rowToKvText(headerCells = [], rowCells = []) {
  const maxLength = Math.max(headerCells.length, rowCells.length);
  const pieces = [];
  for (let index = 0; index < maxLength; index += 1) {
    const rawHeader = String(headerCells[index] || '').trim();
    const header = rawHeader || `列${index + 1}`;
    const value = String(rowCells[index] || '').trim();
    if (!value) continue;
    pieces.push(`${header}: ${value}`);
  }
  return pieces.join('; ');
}

function parseTableRowsFromHtml(tableInnerHtml = '', tableId = '') {
  const rowMatches = [...String(tableInnerHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!rowMatches.length) return [];
  const rows = rowMatches.map((match) => {
    const cellMatches = [...String(match[1] || '').matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    return cellMatches.map((cell) => stripHtml(cell[2] || ''));
  }).filter((cells) => cells.some((item) => item));
  if (!rows.length) return [];
  const header = rows[0];
  const dataRows = rows.slice(1);
  const chunks = [];
  dataRows.forEach((cells, rowIndex) => {
    const rowKvText = rowToKvText(header, cells);
    if (!rowKvText) return;
    chunks.push({
      type: 'table_row',
      text: rowKvText,
      rowKvText,
      tableId,
      rowIndex: rowIndex + 1
    });
  });
  if (chunks.length) {
    chunks.unshift({
      type: 'table_summary',
      text: `表头: ${header.filter(Boolean).join(' | ')}`,
      tableId
    });
  }
  return chunks;
}

function parseXlsxToBlocks(absPath) {
  if (!xlsx) return null;
  const workbook = xlsx.readFile(absPath, { cellDates: true });
  const blocks = [];
  const textPieces = [];
  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) return;
    const rows = xlsx.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: ''
    });
    const compactRows = rows
      .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell || '').trim()) : []))
      .filter((row) => row.some((cell) => cell));
    if (!compactRows.length) return;
    const header = compactRows[0];
    const dataRows = compactRows.slice(1);
    const tableId = `${sheetName}-table-1`;
    blocks.push({
      type: 'heading',
      level: 1,
      text: `工作表 ${sheetName}`
    });
    blocks.push({
      type: 'table_summary',
      text: `表头: ${header.filter(Boolean).join(' | ')}`,
      sheetName,
      tableId
    });
    dataRows.forEach((row, idx) => {
      const rowKvText = rowToKvText(header, row);
      if (!rowKvText) return;
      blocks.push({
        type: 'table_row',
        text: rowKvText,
        rowKvText,
        sheetName,
        tableId,
        rowIndex: idx + 1
      });
      textPieces.push(`[${sheetName}] ${rowKvText}`);
    });
  });
  return {
    rawText: textPieces.join('\n'),
    xlsx: { blocks }
  };
}

async function extractRawText(payload) {
  if (payload.rawText && String(payload.rawText).trim()) {
    return {
      rawText: String(payload.rawText),
      docx: null,
      xlsx: null,
      pdf: null
    };
  }
  const file = await KbFile.findByPk(payload.fileId);
  if (!file) {
    return {
      rawText: '',
      docx: null,
      xlsx: null,
      pdf: null
    };
  }

  const ext = normalizeFileExt(file.fileName, file.fileExt);
  const storageUri = String(file.storageUri || '');
  const localPath = storageUri.startsWith('file://')
    ? storageUri.replace('file://', '')
    : storageUri;
  let absPath = '';
  let tempPath = '';
  try {
    if (isS3Uri(storageUri)) {
      const objectBody = await getObjectBufferByUri(storageUri);
      const extPart = path.extname(file.fileName || '') || '';
      tempPath = path.resolve(os.tmpdir(), `kb-object-${file.id}-${Date.now()}-${Math.round(Math.random() * 1e6)}${extPart}`);
      await fs.writeFile(tempPath, objectBody);
      absPath = tempPath;
    } else {
      if (!localPath || localPath.startsWith('kb://')) {
        return {
          rawText: '',
          docx: null,
          xlsx: null,
          pdf: null
        };
      }
      absPath = path.isAbsolute(localPath)
        ? localPath
        : path.resolve(process.cwd(), localPath);
    }

    if (ext === 'docx') {
      if (!mammoth) {
        const kbJob = await KbJob.findByPk(payload.kbJobId);
        if (kbJob) {
          await kbJob.update({
            status: 'failed',
            lastErrorKey: 'kb.parser.docxUnavailable',
            lastError: 'mammoth_missing'
          });
        }
        throw new Error('kb.parser.docxUnavailable');
      }
      const images = [];
      let imageNo = 0;
      const htmlResult = await mammoth.convertToHtml(
        { path: absPath },
        {
          convertImage: mammoth.images.inline(async (image) => {
            imageNo += 1;
            const contentType = image.contentType || 'image/png';
            const extPart = String(contentType).split('/')[1] || 'bin';
            const imageKey = `docx-image-${imageNo}.${extPart}`;
            const base64 = await image.read('base64');
            const buffer = Buffer.from(base64, 'base64');
            images.push({
              imageKey,
              contentType,
              base64,
              byteLength: buffer.length,
              sha256: crypto.createHash('sha256').update(buffer).digest('hex')
            });
            return { src: `kb-asset://${imageKey}` };
          })
        }
      );
      const html = String(htmlResult.value || '');
      const blocks = [];
      const blockRegex = /<(h[1-6]|p|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let match;
      while ((match = blockRegex.exec(html))) {
        const tag = String(match[1] || '').toLowerCase();
        const inner = String(match[2] || '');
        if (tag === 'table') {
          const tableId = `docx-table-${blocks.filter((item) => item.type === 'table_summary').length + 1}`;
          const tableBlocks = parseTableRowsFromHtml(inner, tableId);
          tableBlocks.forEach((item) => blocks.push(item));
          continue;
        }
        const imageMatches = [...inner.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/gi)];
        imageMatches.forEach((imgItem) => {
          const src = String(imgItem[1] || '');
          if (!src.startsWith('kb-asset://')) return;
          blocks.push({
            type: 'image',
            imageKey: src.replace('kb-asset://', '')
          });
        });
        const text = stripHtml(inner);
        if (!text) continue;
        if (/^h[1-6]$/.test(tag)) {
          blocks.push({
            type: 'heading',
            level: Number(tag.slice(1)) || 1,
            text
          });
        } else {
          blocks.push({
            type: 'paragraph',
            text
          });
        }
      }
      const textBlocks = blocks.filter((item) => item.type !== 'image');
      const freqMap = new Map();
      textBlocks.forEach((item) => {
        const key = normalizeNoiseKey(item.text);
        if (!key) return;
        freqMap.set(key, (freqMap.get(key) || 0) + 1);
      });
      const shouldDropRepeatedShort = (text) => {
        const key = normalizeNoiseKey(text);
        if (!key) return true;
        const repeatCount = Number(freqMap.get(key) || 0);
        return key.length <= 40 && repeatCount >= 3;
      };
      const cleanedBlocks = blocks.filter((item) => {
        if (item.type === 'image') return true;
        const text = String(item.text || '');
        if (isLikelyDocxNoise(text)) return false;
        if (shouldDropRepeatedShort(text)) return false;
        return true;
      });
      const rawText = cleanedBlocks
        .filter((item) => item.type !== 'image')
        .map((item) => item.text)
        .join('\n\n');
      return {
        rawText,
        docx: {
          blocks: cleanedBlocks,
          images
        },
        xlsx: null
      };
    }

    if (ext === 'xlsx') {
      if (!xlsx) {
        throw new Error('kb.parser.xlsxUnavailable');
      }
      const parsed = parseXlsxToBlocks(absPath);
      if (!parsed) {
        throw new Error('kb.parser.xlsxUnavailable');
      }
      return {
        rawText: parsed.rawText,
        docx: null,
        xlsx: parsed.xlsx,
        pdf: null
      };
    }

    if (ext === 'pdf') {
      if (!PDFParse) {
        throw new Error('kb.parser.pdfUnavailable');
      }
      const fileBuffer = await fs.readFile(absPath);
      const parser = new PDFParse({ data: fileBuffer });
      const parsed = await parser.getText();
      await parser.destroy().catch(() => null);
      const structured = await parsePdfToStructured(absPath).catch(() => null);
      const cleanedRawText = extractPdfTextWithNoiseFiltering(parsed?.text || '');
      return {
        rawText: structured?.rawText || cleanedRawText,
        docx: null,
        xlsx: null,
        pdf: structured?.pdf || null
      };
    }

    const text = await fs.readFile(absPath, 'utf8');
    return { rawText: text, docx: null, xlsx: null, pdf: null };
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => null);
    }
  }
}

async function processKbIngestJob(job) {
  const { fileId, kbJobId } = job.data;
  console.log(`[KB处理器] processing queueJob=${job.id}, file=${fileId}, kbJob=${kbJobId}`);
  try {
    const file = await KbFile.findByPk(fileId);
    const reindexOnly = Boolean(job.data?.metadata?.reindexOnly)
      || (Number(job.attemptsMade || 0) > 0 && String(file?.status || '') === 'index_failed');
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'processing',
      progress: 5,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });
    await job.progress(10);
    const parsed = reindexOnly
      ? { rawText: '', docx: null, xlsx: null, pdf: null }
      : await extractRawText(job.data);
    await job.progress(45);
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'processing',
      progress: 45,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });

    const result = await runIngestPipeline({
      fileId,
      kbJobId,
      rawText: parsed.rawText,
      parsedDocx: parsed.docx,
      parsedXlsx: parsed.xlsx,
      parsedPdf: parsed.pdf,
      reindexOnly
    });

    await job.progress(100);
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'done',
      progress: 100,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });
    return {
      queueJobId: job.id,
      ...result,
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    const [file, kbJob] = await Promise.all([
      KbFile.findByPk(fileId),
      KbJob.findByPk(kbJobId)
    ]);
    const parserErrorKey = (
      error.message === 'kb.parser.docxUnavailable'
        ? 'kb.parser.docxUnavailable'
        : (
          error.message === 'kb.parser.xlsxUnavailable'
            ? 'kb.parser.xlsxUnavailable'
            : (error.message === 'kb.parser.pdfUnavailable' ? 'kb.parser.pdfUnavailable' : null)
        )
    );
    const pipelineErrorKey = error.message.includes('kb.index.syncFailed') ? 'kb.index.syncFailed' : null;
    const fallbackErrorKey = parserErrorKey || pipelineErrorKey || 'kb.job.processingFailed';
    if (file) {
      const preserveFileFailure = ['parse_failed', 'index_failed'].includes(String(file.status || ''));
      if (!preserveFileFailure) {
        await file.update({
          status: 'processing_failed',
          errorMessageKey: fallbackErrorKey,
          errorMessage: error.message
        });
      }
    }
    if (kbJob) {
      const preserveJobFailure = String(kbJob.status || '') === 'failed' && kbJob.lastErrorKey;
      if (!preserveJobFailure) {
        await kbJob.update({
          status: 'failed',
          lastErrorKey: fallbackErrorKey,
          lastError: error.message
        });
      }
    }
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'failed',
      progress: Number(job.progress() || 0),
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse'),
      error: error.message
    });
    throw error;
  }
}

module.exports = {
  processKbIngestJob
};
