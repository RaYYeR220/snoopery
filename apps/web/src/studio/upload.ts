import { api } from '../lib/api';

interface Signed {
  uploadUrl: string;
  publicUrl: string;
  headers: Record<string, string>;
  maxBytes: number;
}

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', insv: 'application/octet-stream' };

/** Uploads straight to the asset bucket through a signed URL; returns the public URL the pipeline accepts. */
export async function uploadFile(file: File, onProgress?: (f: number) => void): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = TYPES[ext];
  if (!contentType) throw new Error('Use a JPEG/PNG/WebP photo or an MP4/MOV video.');
  const signed = await api<Signed>('/uploads/sign', { method: 'POST', body: JSON.stringify({ filename: file.name, contentType }) });
  if (file.size > signed.maxBytes) throw new Error(`That file is larger than ${Math.round(signed.maxBytes / 1e6)} MB.`);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signed.uploadUrl);
    for (const [k, v] of Object.entries(signed.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status}).`)));
    xhr.onerror = () => reject(new Error('Upload failed.'));
    xhr.send(file);
  });
  return signed.publicUrl;
}
