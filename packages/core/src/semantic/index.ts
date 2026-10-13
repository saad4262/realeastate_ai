/**
 * The semantic layer (ADR 0036): a catalog of datasets, measures and
 * dimensions written in code, a strict spec the model may produce, and the
 * compiler that turns one into one scoped, read-only SQL statement.
 */
export { DATASET_IDS, DATASETS, datasetDef, TIME_UNITS, type DatasetDef, type DatasetId, type DimensionDef, type MeasureDef, type TimeUnit } from './catalog';
export { describeSpec, effectiveRange, effectiveViz, isTimeUnit, SPEC_LIMITS, SPEC_RANGE_LABELS, SPEC_RANGES, tileSpecSchema, VIZ, type SpecRange, type TileSpec, type TileSpecInput, type Viz } from './spec';
export { catalogForPrompt } from './catalog-text';
export { compileTile, mayViewSpec, runTile, specPermissions, specWindow, type CustomTileData, type SemanticRunContext } from './compile';
export { standardReport } from './report';
export { recordDataGap } from './gap-log';
