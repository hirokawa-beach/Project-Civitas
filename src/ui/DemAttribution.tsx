import type { WorldMetadata } from '../world/metadata';

export function DemAttribution({ world }: { world: WorldMetadata }) {
  const source = world.demImport;
  if (!source) return null;
  return <div class="dem-attribution">
    <p>{source.attribution}</p>
    <p>{source.dataset} · source {source.nominalResolutionMeters} m · output {world.terrainSampleSpacingMeters} m
      {source.tileZoom !== undefined && ` · tile zoom ${source.tileZoom} (${source.rasterSpacingMetersAtCenter?.toFixed(2)} m raster at centre)`}</p>
    <details><summary>GEOGRAPHIC SOURCE / TERMS</summary><p>{source.sourceCrs} · {source.horizontalDatum}</p><p>{source.verticalDatum}</p>
      <p>Centre {source.center.latitude}, {source.center.longitude} · X east, Z south · elevation metres · bilinear</p>
      <p>{source.interpolatedNoDataSamples} partial NoData samples interpolated · {source.license}</p>
      <a href={source.sourceUrl} target="_blank" rel="noreferrer">Source specification</a>{' · '}
      <a href={source.termsUrl} target="_blank" rel="noreferrer">GSI terms</a>{' · '}
      <a href="https://www.gsi.go.jp/LAW/2930-index.html" target="_blank" rel="noreferrer">Survey Act usage guidance</a>
    </details>
  </div>;
}
