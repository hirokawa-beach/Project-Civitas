# World / Map foundation

The Worker owns `WorldMetadata` and City state. A metre remains one world unit. Map schema v1 contains independent width/depth, sample spacing, rows/columns, chunk size, explicit water geometry/boundaries/elevation, configured outside candidates, source/generator and optional georeference metadata. Climate/resources are reserved data, not simulated systems.

City Save v13 stores a detached copy under `world.metadata`. Versions 1–12 migrate with their terrain dimensions and sample spacing, default 256m chunks and `legacy-height` water mode. This preserves StaticWater semantics. New explicit maps will use independently authored water bodies. The legacy constants are defaults for compatibility, not new-map limits.

Map Assets will own the initial height data plus this same metadata and separate library identity/name/description. A City copies an asset on start and never reads it again by reference. DEM/GIS parsing is deferred; importers can provide heights, world metres and the optional CRS/affine metadata to the asset validation API. Water geometry comes from hydrography/editor data, not subsequent terrain elevation queries.

World dimensions are limited by explicit allocation validation (up to 65,536m, 16,777,216 terrain samples). This is a safety bound for current in-memory storage, not a streaming guarantee. Resolution is selectable independently of physical size. Dirty terrain patches and camera-local meshes avoid whole-world frame work. Complete streaming/terrain LOD are deferred per #41.
