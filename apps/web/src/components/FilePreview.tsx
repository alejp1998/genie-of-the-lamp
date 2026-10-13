import { useRef, useState } from 'react';
import { withBase } from '../basePath';
import PdfPane, { type PdfPaneHandle } from './PdfPane';

export const PREVIEWABLE = /\.(png|jpe?g|gif|webp|svg|pdf)$/i;

/** A file URL the browser can render: project files come from the file route, anything else is passed as is. */
export function projectFileUrl(projectId: string, branch: string, path: string, bust?: string | number): string {
  return withBase(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}${bust ? `&t=${bust}` : ''}`);
}

/** Image or PDF shown where the editor would be: zoom for both, find for PDFs. */
export function MediaView({ src, kind, name }: { src: string; kind: 'image' | 'pdf'; name: string }) {
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const pdfRef = useRef<PdfPaneHandle>(null);
  return (
    <div className="file-preview" data-testid="file-preview" data-kind={kind}>
      <div className="file-preview__bar">
        <span className="file-preview__meta">{kind === 'pdf' ? 'PDF' : size ? `${size.w} × ${size.h}` : 'Image'}</span>
        <span className="toolbar__spacer" />
        {kind === 'pdf' && <button className="btn btn--ghost btn--small" onClick={() => pdfRef.current?.openFind()} data-testid="file-preview-find">Find</button>}
        <div className="zoom">
          <button className="btn btn--ghost btn--small" onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
          <button className="zoom__label" onClick={() => setZoom(1)} aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
          <button className="btn btn--ghost btn--small" onClick={() => setZoom((z) => Math.min(4, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
        </div>
        <a className="btn btn--ghost btn--small" href={src} download={name.split('/').pop()}>Download</a>
      </div>
      {kind === 'pdf' ? (
        <PdfPane ref={pdfRef} pdfUrl={src} status="ok" zoom={zoom} ready onFirstOpen={() => {}} />
      ) : (
        <div className="file-preview__stage">
          <img
            src={src}
            alt={name}
            data-testid="file-preview-image"
            style={size ? { width: Math.round(size.w * zoom) } : { maxWidth: '100%' }}
            onLoad={(e) => {
              const img = e.currentTarget;
              // Fit wide images to the pane at 100%; keep small ones at their own size.
              const fit = Math.min(1, (img.parentElement!.clientWidth - 32) / img.naturalWidth);
              setSize({ w: Math.round(img.naturalWidth * fit), h: Math.round(img.naturalHeight * fit) });
            }}
          />
        </div>
      )}
    </div>
  );
}

/** A previewable file from the project. */
export default function FilePreview({ projectId, branch, path }: { projectId: string; branch: string; path: string }) {
  const kind = /\.pdf$/i.test(path) ? 'pdf' : 'image';
  return <MediaView key={path} src={projectFileUrl(projectId, branch, path)} kind={kind} name={path} />;
}
