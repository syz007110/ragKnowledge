import { renderAsync } from 'docx-preview';
import * as XLSX from 'xlsx';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render uploaded .docx bytes (same as MinIO/local stored file) into a DOM node.
 */
export async function renderDocxPreview(container, arrayBuffer) {
  if (!container || !arrayBuffer) return;
  container.innerHTML = '';
  const blob = new Blob([arrayBuffer]);
  await renderAsync(blob, container, undefined, {
    inWrapper: true,
    ignoreWidth: false,
    breakPages: true
  });
}

/**
 * Render uploaded .xlsx bytes as HTML tables (one block per sheet).
 */
export function renderXlsxPreview(container, arrayBuffer) {
  if (!container || !arrayBuffer) return;
  container.innerHTML = '';
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const wrap = document.createElement('div');
  wrap.className = 'xlsx-preview-inner';

  wb.SheetNames.forEach((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return;
    const panel = document.createElement('div');
    panel.className = 'xlsx-preview-sheet-panel';
    const title = document.createElement('h4');
    title.className = 'xlsx-preview-sheet-title';
    title.textContent = name;
    panel.appendChild(title);
    const holder = document.createElement('div');
    holder.className = 'xlsx-preview-table-wrap';
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!rows.length) {
      holder.innerHTML = '<p class="xlsx-preview-empty">(empty)</p>';
    } else {
      let html = '<table class="xlsx-preview-table"><tbody>';
      rows.forEach((row) => {
        html += '<tr>';
        (Array.isArray(row) ? row : []).forEach((cell) => {
          const t = cell == null ? '' : String(cell);
          html += `<td>${escapeHtml(t)}</td>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table>';
      holder.innerHTML = html;
    }
    panel.appendChild(holder);
    wrap.appendChild(panel);
  });

  container.appendChild(wrap);
}
