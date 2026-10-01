import { importDem } from './importer';
import { gsiTileProvider, type GsiDataset } from './gsiTiles';
import { gsiGmlProvider } from './gsiGml';
import type { DemRequest } from './types';

export interface DemImportMessage { request: DemRequest; dataset: GsiDataset; files?: { name: string; xml: string }[] }
self.onmessage = async ({ data }: MessageEvent<DemImportMessage>) => {
  try {
    const provider = data.files ? gsiGmlProvider(data.files) : gsiTileProvider(data.dataset);
    const asset = await importDem(provider, data.request, undefined, message => self.postMessage({ type: 'progress', message }));
    self.postMessage({ type: 'complete', asset });
  } catch (cause) { self.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
};
