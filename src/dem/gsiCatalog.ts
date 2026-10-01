export const GSI_DATASETS = {
  DEM1A: { path: 'dem1a_png', maxZoom: 17, resolution: 1 },
  DEM5A: { path: 'dem5a_png', maxZoom: 15, resolution: 5 },
  DEM5B: { path: 'dem5b_png', maxZoom: 15, resolution: 5 },
  DEM5C: { path: 'dem5c_png', maxZoom: 15, resolution: 5 },
  DEM10B: { path: 'dem_png', maxZoom: 14, resolution: 10 },
} as const;
export type GsiDataset = keyof typeof GSI_DATASETS;
