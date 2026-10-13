import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc ||= new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
import type { Attachment } from './api';
import type { ItemAttachment } from './transcript';

/**
 * Turns a dropped, pasted or picked file into something the model can read:
 * text files as text, PDFs as the file plus its extracted text (for models
 * without PDF input), images as images. Anything else is refused by name.
 */

const MODEL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const TEXT_EXT = /\.(tex|ltx|sty|cls|bib|bst|bbx|cbx|dtx|ins|txt|md|markdown|rst|log|aux|blg|csv|tsv|json|ya?ml|toml|ini|cfg|conf|xml|html?|css|js|mjs|ts|tsx|jsx|py|r|m|jl|c|h|cpp|hpp|cc|java|kt|go|rs|rb|php|sh|bash|zsh|ps1|sql|tikz|pgf|gp|plt|dat|asy|svg)$/i;

export class IntakeError extends Error {}

export interface Intake { attachment: Attachment; preview: ItemAttachment; label: string }

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** No NUL bytes and valid UTF-8 in the first 64 KB: good enough to call it text. */
async function looksLikeText(file: File): Promise<boolean> {
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head); return true; } catch { return false; }
}

/** Browser-decodable images in other formats (BMP, ICO, AVIF…) are re-encoded as PNG. */
async function toPng(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new IntakeError(`${file.name || 'That image'} could not be decoded; attach PNG, JPEG, GIF or WebP.`); });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new IntakeError('Could not convert the image'))), 'image/png'));
}

async function pdfText(data: ArrayBuffer): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const pages: string[] = [];
    let total = 0;
    for (let i = 1; i <= doc.numPages && total < MAX_TEXT_CHARS; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const text = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('');
      pages.push(`[page ${i}]\n${text.trim()}`);
      total += text.length;
    }
    return pages.join('\n\n').slice(0, MAX_TEXT_CHARS);
  } finally {
    void doc.destroy();
  }
}

export async function intake(file: File): Promise<Intake> {
  // Clipboard images come as "image.png" (or nameless): give them a name a person can tell apart.
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const name = generic && file.type.startsWith('image/') ? `Screenshot ${new Date().toLocaleTimeString()}.png` : file.name || 'Pasted file';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > MAX_PDF_BYTES) throw new IntakeError(`${name} is over 20 MB.`);
    const buf = await file.arrayBuffer();
    const text = await pdfText(buf).catch(() => '');
    const data = await readBase64(file);
    return { label: name, attachment: { kind: 'pdf', name, data, ...(text ? { text } : {}) }, preview: { kind: 'pdf', name, src: URL.createObjectURL(file) } };
  }
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
    const blob = MODEL_IMAGE_TYPES.includes(file.type) ? file : await toPng(file);
    if (blob.size > MAX_IMAGE_BYTES) throw new IntakeError(`${name} is over 5 MB.`);
    const mediaType = MODEL_IMAGE_TYPES.includes(file.type) ? file.type : 'image/png';
    return { label: name, attachment: { kind: 'image', name, mediaType, data: await readBase64(blob) }, preview: { kind: 'image', name, src: URL.createObjectURL(blob) } };
  }
  if (await looksLikeText(file)) {
    let text = await file.text();
    if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[cut at ${MAX_TEXT_CHARS} characters]`;
    return { label: name, attachment: { kind: 'text', name, text }, preview: { kind: 'text', name, text } };
  }
  throw new IntakeError(`${name} is not a text file, PDF or image, so the assistant could not read it.`);
}
