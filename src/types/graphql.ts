export type DataSourceType =
  | 'EDGE_LOGS'
  | 'COMMERCE_LEDGER'
  | 'IOT_TELEMETRY'
  | 'SECURITY_AUDIT';

export type RawFormatType = 'JSON' | 'CSV' | 'NDJSON' | 'XML';
export type SeverityLevel = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RecordStatus =
  | 'ACTIVE'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'DEGRADED'
  | 'QUARANTINED';
export type FaultMode =
  | 'NONE'
  | 'LATENCY_SPIKE'
  | 'INTERMITTENT_503'
  | 'CORRUPT_PAYLOAD';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type SortField =
  | 'TIMESTAMP'
  | 'LATENCY_MS'
  | 'AMOUNT_USD'
  | 'SEVERITY'
  | 'TITLE'
  | 'SOURCE';
export type SortDirection = 'ASC' | 'DESC';
export type GroupByField = 'SOURCE' | 'SEVERITY' | 'STATUS' | 'REGION' | 'CATEGORY';

export interface RegionHealth {
  totalRecords: number;
  anomalyCount: number;
  avgLatencyMs: number;
  availabilityPct: number;
}

export interface Region {
  id: string;
  code: string;
  name: string;
  continent: string;
  complianceTier: string;
  slaTargetPct: number;
  health?: RegionHealth;
  clusters?: Cluster[];
}

export interface Cluster {
  id: string;
  name: string;
  tier: string;
  kubernetesVersion: string;
  capacityNodes: number;
  regionId: string;
  region?: Region;
  services?: ServiceNode[];
}

export interface RelatedIncident {
  id: string;
  code: string;
  title: string;
  severity: SeverityLevel;
  impactScore: number;
  openedAt: string;
}

export interface ServiceNode {
  id: string;
  name: string;
  domain: string;
  ownerTeam: string;
  version: string;
  rpsBaseline: number;
  clusterId: string;
  cluster?: Cluster;
  relatedIncidents?: RelatedIncident[];
  recentRecords?: DataRecord[];
}

export interface RecordMetrics {
  latencyMs: number;
  cpuPct: number;
  memoryMb: number;
  amountUsd: number;
  throughputRps: number;
  packetLossPct: number;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  note: string;
}

export interface DataRecord {
  id: string;
  externalId: string;
  source: DataSourceType;
  rawFormat: RawFormatType;
  rawSnippet?: string;
  category: string;
  title: string;
  message: string;
  severity: SeverityLevel;
  status: RecordStatus;
  timestamp: string;
  regionCode: string;
  tags: string[];
  hasAnomaly: boolean;
  metrics?: RecordMetrics;
  service?: ServiceNode;
  auditTrail?: AuditEvent[];
}

export interface PageInfo {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface QueryExecutionMeta {
  traceId: string;
  cacheHit: boolean;
  queryDurationMs: number;
  totalStoreRecords: number;
}

export interface RecordConnection {
  items: DataRecord[];
  edges: Array<{ cursor: string; node: DataRecord }>;
  totalCount: number;
  pageInfo: PageInfo;
  executionMeta: QueryExecutionMeta;
}

export interface AggregationBucket {
  key: string;
  count: number;
  sharePct: number;
  anomalyCount: number;
  avgLatencyMs: number;
  totalAmountUsd: number;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  component: string;
  startOffsetMs: number;
  durationMs: number;
  status: string;
  metadata: string;
}

export interface ExecutionTrace {
  traceId: string;
  operationName: string;
  operationType: string;
  timestamp: string;
  durationMs: number;
  depth: number;
  complexity: number;
  cacheHit: boolean;
  rateLimited: boolean;
  loaderBatches: number;
  loaderCallsSaved: number;
  status: string;
  errorCode: string | null;
  spans: TraceSpan[];
}

export interface CollectorStatus {
  source: DataSourceType;
  label: string;
  format: RawFormatType;
  endpointLabel: string;
  enabled: boolean;
  circuitState: CircuitState;
  faultMode: FaultMode;
  consecutiveFailures: number;
  totalCollected: number;
  totalBatches: number;
  totalFailures: number;
  totalRetries: number;
  lastRunAt: string | null;
  lastDurationMs: number;
  lastError: string | null;
  nextRetryAt: string | null;
}

export interface LoadControlConfig {
  maxRequestsPerMinute: number;
  burstCapacity: number;
  maxQueryDepth: number;
  maxQueryComplexity: number;
  cacheTtlMs: number;
  autoCollectorEnabled: boolean;
  autoCollectorIntervalMs: number;
}

export interface SystemTelemetry {
  totalRecords: number;
  anomalyCount: number;
  totalRegions: number;
  totalClusters: number;
  totalServices: number;
  totalQueriesExecuted: number;
  totalRejectedRequests: number;
  totalLoaderCallsSaved: number;
  uptimeSeconds: number;
  collectors: CollectorStatus[];
  rateLimiter: {
    availableTokens: number;
    burstCapacity: number;
    maxRequestsPerMinute: number;
    totalAllowed: number;
    totalThrottled: number;
  };
  cache: {
    entries: number;
    hits: number;
    misses: number;
    hitRatioPct: number;
    ttlMs: number;
  };
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    requestsPerMinute: number;
  };
  governance: LoadControlConfig;
  recentTraces: ExecutionTrace[];
}
